import type {
  Track, Sector, Car, Driver, RaceConfig, RaceResult, RaceEntry,
  CarRaceState, CompoundProfile, EnergyMode, LapLogEntry, TireState,
} from './types.js';
import { COMPOUND_PROFILES } from './data.js';
import { RNG } from './rng.js';

// =====================================================================
// CONSTANTES DE BALANCEAMENTO
// =====================================================================
// Estes números ficam aqui em vez de mágicos no código pra facilitar tuning.

const PERF_SCALE_PER_POINT = 0.0015; // cada ponto de performance = 0.15% do tempo do setor
const DRIVER_SCALE_PER_POINT = 0.0008; // cada ponto de pace do piloto = 0.08% do tempo
const FUEL_SECONDS_PER_KG = 0.030;   // ~0.03s por kg de combustível
const FUEL_BURN_PER_LAP = 1.6;        // kg consumidos por volta (aprox 100kg/63voltas)
const STARTING_FUEL = 110;             // kg de partida

// Energia 2026:
const MAX_HARVEST_PER_LAP = 8.5;     // MJ regulamentar
const MAX_DEPLOY_PER_LAP = 8.5;      // MJ regulamentar
const OVERTAKE_BONUS_MJ = 0.5;       // MJ extra quando ativo

// Variabilidade de pace (gaussiana). Sigma escalado por consistência do piloto.
const BASE_PACE_SIGMA_PCT = 0.0025;  // 0.25% do tempo do setor

// =====================================================================
// CÁLCULO DE PACE DE SETOR
// =====================================================================
// Fórmula central. Cada modificador é multiplicativo sobre o tempo base.
// Resultado: tempo do setor pra este carro/piloto/pneu/combustível/energia.
// =====================================================================

interface SectorContext {
  track: Track;
  sector: Sector;
  car: Car;
  driver: Driver;
  state: CarRaceState;
  trafficPenalty: number;     // segundos perdidos por estar em ar sujo
  energyDeployedMJ: number;   // MJ deployados neste setor (0 a algo razoável)
  rng: RNG;
}

function calculateSectorTime(ctx: SectorContext): number {
  const { sector, car, driver, state, trafficPenalty, energyDeployedMJ, rng } = ctx;

  // 1) Performance do carro ponderada pelos pesos do setor.
  //    Faz "média ponderada" das características relevantes pra este setor.
  const carScore =
    car.performance.aero * sector.aeroWeight +
    ((car.performance.powerICE + car.performance.powerBattery) / 2) * sector.powerWeight +
    car.performance.mechanical * sector.mechWeight;
  // Carro de referência (100): deficit = 0. Carro de 80: deficit grande.
  const carDeficit = (100 - carScore) * PERF_SCALE_PER_POINT;

  // 2) Skill do piloto. Pace puro afeta tempo, racecraft é pra ultrapassagem.
  const driverDeficit = (100 - driver.attributes.pace) * DRIVER_SCALE_PER_POINT;

  // 3) Pneu: composto + idade + cliff.
  const tireOffset = computeTireOffsetSeconds(state.tire, sector);

  // 4) Combustível: cada kg pesa em pace. Inicialmente carregado, fica leve no fim.
  const fuelOffset = state.fuelKg * FUEL_SECONDS_PER_KG * (sector.baseTime / 76.5);
  // ^ scaled pelo tamanho do setor (volta de Imola ~76.5s)

  // 5) Energia: deploy ganha tempo, scaled pelo benefit do setor.
  const energyGain = energyDeployedMJ * sector.deployBenefit;

  // 6) Tempo base × deficits multiplicativos
  const baseWithDeficits = sector.baseTime * (1 + carDeficit) * (1 + driverDeficit);

  // 7) Variabilidade gaussiana, escalada por consistência do piloto.
  //    Piloto 95 de consistência = ~50% da variação base. Piloto 70 = 150%.
  const consistencyFactor = (130 - driver.attributes.consistency) / 60;
  const sigma = sector.baseTime * BASE_PACE_SIGMA_PCT * consistencyFactor;
  const noise = rng.gaussian(0, sigma);

  return baseWithDeficits + tireOffset + fuelOffset - energyGain + trafficPenalty + noise;
}

// Pneu: paceOffset é "linear scaled" pra setor, depois soma degradação acumulada.
function computeTireOffsetSeconds(tire: TireState, sector: Sector): number {
  const profile = COMPOUND_PROFILES[tire.compound];
  if (!profile) return 0;

  // paceOffset é por VOLTA. Escala pra fração do setor na volta total.
  // Volta total Imola ~76.5s. Setor 1 = 26.5s = 34.6%.
  const sectorFraction = sector.baseTime / 76.5;
  const compoundOffset = profile.paceOffset * sectorFraction;

  // Degradação cumulativa, com cliff.
  let degradation = profile.degPerLap * tire.laps;
  if (tire.laps > profile.cliffLap) {
    const lapsAfterCliff = tire.laps - profile.cliffLap;
    degradation += lapsAfterCliff * profile.degPerLap * 2.0; // 3x total (1x base + 2x extra)
  }

  return (compoundOffset + degradation * sectorFraction);
}

// =====================================================================
// LOOP PRINCIPAL DE CORRIDA
// =====================================================================

export function simulateRace(config: RaceConfig): RaceResult {
  const rng = new RNG(config.seed);
  const states: CarRaceState[] = config.entries.map((e, idx) => ({
    driverId: e.driver.id,
    carId: e.car.teamId,
    position: idx + 1,
    totalTime: 0,
    lapsCompleted: 0,
    tire: { compound: e.startCompound, laps: 0 },
    energy: { battery: e.car.batteryCapacity, mode: e.startEnergyMode, overtakeAvailable: false },
    fuelKg: STARTING_FUEL,
    retired: false,
    lastLapTime: null,
    lastSectorTimes: null,
  }));

  // Largada: penalidade de "primeira volta" pequena, ordem mantida (sem pit stop ainda)
  applyStartPenalty(states, config.entries, rng);

  const lapLog: LapLogEntry[] = [];

  for (let lap = 1; lap <= config.track.laps; lap++) {
    simulateLap(lap, config, states, rng, lapLog);
  }

  // Ordenação final: não-retirados pelo tempo total, retirados no fim por voltas completadas.
  const finishOrder = [...states].sort((a, b) => {
    if (a.retired && !b.retired) return 1;
    if (!a.retired && b.retired) return -1;
    if (a.retired && b.retired) return b.lapsCompleted - a.lapsCompleted;
    return a.totalTime - b.totalTime;
  });

  return { finishOrder, lapLog, totalLaps: config.track.laps };
}

function applyStartPenalty(states: CarRaceState[], entries: RaceEntry[], rng: RNG): void {
  // Cada posição perde ~0.4s (carro fisicamente atrás, atravessa linha depois).
  // P1=0, P10=3.6s. Pequeno ruído por largada do piloto.
  states.forEach((s, idx) => {
    const entry = entries[idx]!;
    const positionPenalty = idx * 0.40;
    const driverFactor = (100 - entry.driver.attributes.pace) * 0.005;
    const noise = rng.gaussian(0, 0.10);
    s.totalTime += positionPenalty + driverFactor + noise;
  });
}

// =====================================================================
// SIMULAÇÃO DE UMA VOLTA
// =====================================================================

function simulateLap(
  lap: number,
  config: RaceConfig,
  states: CarRaceState[],
  rng: RNG,
  lapLog: LapLogEntry[],
): void {
  const events: string[] = [];

  // Snapshot da ordem e tempos NO INÍCIO da volta. Crítico: usamos estes
  // valores pra calcular tráfego, ar sujo, ultrapassagem. Sem isso, quando o
  // primeiro carro processa e atualiza totalTime, o segundo carro vê um gap
  // gigante e calcula penalidade absurda. Bug original.
  const startOfLapOrder = [...states]
    .filter(s => !s.retired)
    .sort((a, b) => a.totalTime - b.totalTime);
  const snapshotTimes = new Map(startOfLapOrder.map(s => [s.driverId, s.totalTime]));

  for (let i = 0; i < startOfLapOrder.length; i++) {
    const state = startOfLapOrder[i]!;
    const entry = config.entries.find(e => e.driver.id === state.driverId)!;

    // -- Gap pra carro à frente, USANDO SNAPSHOT (não totalTime atual)
    const aheadSnapshot = i > 0 ? snapshotTimes.get(startOfLapOrder[i - 1]!.driverId)! : null;
    const ownSnapshot = snapshotTimes.get(state.driverId)!;
    const gapAhead = aheadSnapshot !== null ? ownSnapshot - aheadSnapshot : Infinity;

    // -- ENERGIA: Overtake mode (se a <1s do carro à frente no início da volta)
    state.energy.overtakeAvailable = gapAhead < 1.0 && gapAhead >= 0;

    // -- ENERGIA: planeja deploy desta volta segundo modo
    const deployBudgetThisLap = planEnergyDeploy(state, entry.car);
    const sectorDeploys = distributeDeployAcrossSectors(deployBudgetThisLap, config.track.sectors);

    // -- TRÁFEGO: penalidade se há carro na frente a <1.0s (ar sujo)
    let trafficPenaltyTotal = 0;
    if (gapAhead >= 0 && gapAhead < 1.0) {
      trafficPenaltyTotal = (1.0 - gapAhead) * 0.4;
    } else if (gapAhead >= 1.0 && gapAhead < 2.0) {
      trafficPenaltyTotal = (2.0 - gapAhead) * 0.1;
    }
    const trafficPerSector = trafficPenaltyTotal / 3;

    // -- SIMULA OS 3 SETORES
    const sectorTimes: [number, number, number] = [0, 0, 0];
    let lapTime = 0;
    let totalHarvested = 0;

    for (let sIdx = 0; sIdx < 3; sIdx++) {
      const sector = config.track.sectors[sIdx]!;
      const ctx: SectorContext = {
        track: config.track,
        sector,
        car: entry.car,
        driver: entry.driver,
        state,
        trafficPenalty: trafficPerSector,
        energyDeployedMJ: sectorDeploys[sIdx]!,
        rng,
      };
      const t = calculateSectorTime(ctx);
      sectorTimes[sIdx] = t;
      lapTime += t;

      const harvestThisSector = computeHarvest(state.energy.mode, sector, entry.car);
      totalHarvested += harvestThisSector;
    }

    // -- ATUALIZA ESTADO DO CARRO
    state.totalTime += lapTime;
    state.lapsCompleted = lap;
    state.tire.laps += 1;
    state.fuelKg = Math.max(0, state.fuelKg - FUEL_BURN_PER_LAP);
    state.lastLapTime = lapTime;
    state.lastSectorTimes = sectorTimes;

    const totalDeployed = sectorDeploys.reduce((a, b) => a + b, 0);
    state.energy.battery = Math.max(0, Math.min(
      entry.car.batteryCapacity,
      state.energy.battery - totalDeployed + totalHarvested,
    ));

    // -- PIT STOP no final desta volta?
    const pitStop = entry.pitStops.find(p => p.lap === lap);
    if (pitStop) {
      state.totalTime += config.track.pitLaneLossSeconds;
      state.tire = { compound: pitStop.newCompound, laps: 0 };
      if (pitStop.newEnergyMode) state.energy.mode = pitStop.newEnergyMode;
      events.push(`L${lap}: ${entry.driver.name} parou nos boxes — ${pitStop.newCompound.toUpperCase()}`);
    }

    // -- ULTRAPASSAGEM: usa snapshot pra detectar proximidade
    if (i > 0 && gapAhead >= 0 && gapAhead < 1.0) {
      const ahead = startOfLapOrder[i - 1]!;
      const aheadEntry = config.entries.find(e => e.driver.id === ahead.driverId)!;
      const passResult = tryOvertake(state, entry, ahead, aheadEntry, config.track, rng);
      if (passResult.passed) {
        // Atacante sai 0.15s à frente do defensor (já com tempo da volta aplicado)
        state.totalTime = ahead.totalTime - 0.15;
        events.push(`L${lap}: ${entry.driver.name} ultrapassa ${aheadEntry.driver.name}`);
      } else if (passResult.attempted) {
        events.push(`L${lap}: ${entry.driver.name} tenta passar ${aheadEntry.driver.name} — defendido`);
      }
    }
  }

  // -- LOG DA VOLTA
  const standings = [...states]
    .filter(s => !s.retired)
    .sort((a, b) => a.totalTime - b.totalTime);
  const leaderTime = standings[0]?.totalTime ?? 0;

  const lapEntry: LapLogEntry = {
    lap,
    standings: standings.map((s, idx) => {
      const entry = config.entries.find(e => e.driver.id === s.driverId)!;
      s.position = idx + 1;
      return {
        position: idx + 1,
        driverName: entry.driver.name,
        teamName: entry.car.teamName,
        gapToLeader: s.totalTime - leaderTime,
        lapTime: s.lastLapTime ?? 0,
        sectorTimes: s.lastSectorTimes ?? [0, 0, 0],
        tire: { ...s.tire },
        battery: s.energy.battery,
      };
    }),
    events,
  };
  lapLog.push(lapEntry);
}

// =====================================================================
// ENERGIA — planejamento e harvest
// =====================================================================

function planEnergyDeploy(state: CarRaceState, car: Car): number {
  // Quanto deployar nesta volta segundo modo + bateria atual + overtake bonus.
  const battery = state.energy.battery;
  let target = 0;
  switch (state.energy.mode) {
    case 'recharge': target = Math.min(battery * 0.30, 2.0); break;
    case 'balanced': target = Math.min(battery * 0.85, 4.0); break;
    case 'attack':   target = Math.min(battery * 1.00, MAX_DEPLOY_PER_LAP); break;
  }
  if (state.energy.overtakeAvailable) target += OVERTAKE_BONUS_MJ;
  return Math.min(target, MAX_DEPLOY_PER_LAP);
}

function distributeDeployAcrossSectors(
  totalMJ: number,
  sectors: readonly [Sector, Sector, Sector],
): [number, number, number] {
  // Distribui proporcional ao deployBenefit (mais pra setores onde dá mais ganho).
  const sumBenefit = sectors.reduce((a, s) => a + s.deployBenefit, 0);
  return [
    totalMJ * (sectors[0].deployBenefit / sumBenefit),
    totalMJ * (sectors[1].deployBenefit / sumBenefit),
    totalMJ * (sectors[2].deployBenefit / sumBenefit),
  ];
}

function computeHarvest(mode: EnergyMode, sector: Sector, car: Car): number {
  // Recarga depende do potencial do setor (frenagens) e do modo escolhido.
  // Em "attack" a recarga é menor porque carro está acelerando mais e usando
  // mais o motor; em "recharge" o piloto sacrifica pace pra harvestar.
  const modeFactor = mode === 'recharge' ? 0.95 : mode === 'balanced' ? 0.65 : 0.45;
  const efficiencyFactor = car.performance.powerBattery / 100;
  return sector.harvestPotential * modeFactor * efficiencyFactor;
}

// =====================================================================
// ULTRAPASSAGEM
// =====================================================================
// Decisão por volta. Se o atacante está perto e tem delta de pace, tenta.
// Probabilidade modulada por: skill de ataque vs defesa, dificuldade da pista,
// vantagem de overtake mode (energia), e diferença de pneu.
// =====================================================================

interface OvertakeAttempt {
  attempted: boolean;
  passed: boolean;
}

function tryOvertake(
  attacker: CarRaceState,
  attackerEntry: RaceEntry,
  defender: CarRaceState,
  defenderEntry: RaceEntry,
  track: Track,
  rng: RNG,
): OvertakeAttempt {
  const gap = attacker.totalTime - defender.totalTime;
  if (gap > 1.0 || gap < 0) return { attempted: false, passed: false };

  // Delta de pace estimado (volta da última)
  const attackerLap = attacker.lastLapTime ?? 999;
  const defenderLap = defender.lastLapTime ?? 999;
  const paceDelta = defenderLap - attackerLap; // positivo = atacante mais rápido

  // Sem ritmo melhor não tenta:
  if (paceDelta < 0.05) return { attempted: false, passed: false };

  // Probabilidade de tentativa: scaling pelo gap (mais perto, mais tenta)
  const proximityFactor = (1.0 - gap) / 1.0; // 0..1
  const attemptProb = Math.min(0.85, proximityFactor * 0.9);
  if (!rng.chance(attemptProb)) return { attempted: false, passed: false };

  // Probabilidade de sucesso:
  const attack = attackerEntry.driver.attributes.attack;
  const defense = defenderEntry.driver.attributes.defense;
  const skillDelta = (attack - defense) / 100; // -0.3 a +0.3 normalmente

  const overtakeBonus = attacker.energy.overtakeAvailable ? 0.10 : 0;
  const trackEase = 1 - track.overtakingDifficulty; // Monza alto, Mônaco baixo
  const paceFactor = Math.min(0.30, paceDelta / 2.0);

  let successProb = 0.20 + skillDelta + overtakeBonus + (trackEase * 0.25) + paceFactor;
  successProb = Math.max(0.05, Math.min(0.85, successProb));

  return { attempted: true, passed: rng.chance(successProb) };
}
