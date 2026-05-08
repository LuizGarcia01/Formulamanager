import type {
  Track, Sector, Car, Driver, RaceConfig, RaceResult, RaceEntry,
  CarRaceState, CompoundProfile, EnergyMode, LapLogEntry, TireState,
  WeatherForecast, WeatherState, RaceFlagState, Compound, ReactiveStrategy,
} from './types.js';
import { COMPOUND_PROFILES } from './data.js';
import { RNG } from './rng.js';

// =====================================================================
// CONSTANTES DE BALANCEAMENTO
// =====================================================================

const PERF_SCALE_PER_POINT = 0.0015;
const DRIVER_SCALE_PER_POINT = 0.0008;
const FUEL_SECONDS_PER_KG = 0.030;
const FUEL_BURN_PER_LAP = 1.6;
const STARTING_FUEL = 110;

const MAX_HARVEST_PER_LAP = 8.5;
const MAX_DEPLOY_PER_LAP = 8.5;
const OVERTAKE_BONUS_MJ = 0.5;

const BASE_PACE_SIGMA_PCT = 0.0025;

// Eventos / falhas
// Probabilidade BASE por volta de uma falha mecânica (modulada por reliability):
const BASE_MECHANICAL_FAILURE_PROB = 0.0015;
// Probabilidade BASE por volta de erro de piloto (spin/escapada):
const BASE_DRIVER_ERROR_PROB = 0.0010;
// Probabilidade base de incidente entre carros próximos disputando ultrapassagem:
const COLLISION_RISK_BASE = 0.015;

// Safety Car
const SC_DURATION_LAPS = 4;          // SC fica em pista 4 voltas
const SC_LAP_TIME_MULTIPLIER = 1.40; // sob SC, voltas 40% mais lentas
const VSC_LAP_TIME_MULTIPLIER = 1.30;
const SC_PIT_LANE_DISCOUNT = 0.55;   // pit sob SC custa 55% do normal (carros estão lentos)

// Chuva: penalidade de pace por nível de wetness em pneu errado
const WET_PACE_PENALTY_PER_LEVEL = 8.0; // segundos por volta com pneu seco em pista 100% molhada

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
  trafficPenalty: number;
  energyDeployedMJ: number;
  weather: WeatherState;
  rng: RNG;
}

function calculateSectorTime(ctx: SectorContext): number {
  const { sector, car, driver, state, trafficPenalty, energyDeployedMJ, weather, rng } = ctx;

  // 1) Performance do carro ponderada pelos pesos do setor.
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

  // 6) Clima: penalidade por pneu errado pro nível de molhado da pista.
  const weatherPenalty = computeWeatherPenalty(state.tire, weather, driver, sector);

  // 7) Tempo base × deficits multiplicativos
  const baseWithDeficits = sector.baseTime * (1 + carDeficit) * (1 + driverDeficit);

  // 8) Variabilidade gaussiana, escalada por consistência do piloto.
  //    Piloto 95 de consistência = ~50% da variação base. Piloto 70 = 150%.
  //    Em chuva, variabilidade aumenta — mas atenuada por wetSkill do piloto.
  const consistencyFactor = (130 - driver.attributes.consistency) / 60;
  const wetnessNoiseMultiplier = 1 + (weather.wetness * (1 - driver.attributes.wetSkill / 100) * 2);
  const sigma = sector.baseTime * BASE_PACE_SIGMA_PCT * consistencyFactor * wetnessNoiseMultiplier;
  const noise = rng.gaussian(0, sigma);

  return baseWithDeficits + tireOffset + fuelOffset - energyGain + weatherPenalty + trafficPenalty + noise;
}

// =====================================================================
// PENALIDADE DE CLIMA POR PNEU
// =====================================================================
// Cada composto tem uma "janela ideal" de wetness:
// - Slicks (soft/medium/hard): ideais em wetness 0
// - Intermediate: ideal em wetness ~0.5
// - Wet: ideal em wetness ~0.85
// Fora da janela, perde tempo proporcional ao desvio.
function computeWeatherPenalty(
  tire: TireState,
  weather: WeatherState,
  driver: Driver,
  sector: Sector,
): number {
  const sectorFraction = sector.baseTime / 76.5;
  const w = weather.wetness;
  let optimalWetness = 0;
  let toleranceWindow = 0.15;  // quão longe da janela ideal sem perder muito

  switch (tire.compound) {
    case 'soft': case 'medium': case 'hard':
      optimalWetness = 0; toleranceWindow = 0.15; break;
    case 'intermediate':
      optimalWetness = 0.5; toleranceWindow = 0.25; break;
    case 'wet':
      optimalWetness = 0.85; toleranceWindow = 0.20; break;
  }

  const deviation = Math.max(0, Math.abs(w - optimalWetness) - toleranceWindow);
  // Penalidade exponencial em pneu MUITO errado (slick em chuva forte = catástrofe)
  const penalty = Math.pow(deviation * 2, 2) * WET_PACE_PENALTY_PER_LEVEL * sectorFraction;
  // Skill em chuva reduz a penalidade (até 30%):
  const wetSkillReduction = (driver.attributes.wetSkill / 100) * 0.3;
  return penalty * (1 - wetSkillReduction);
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

  applyStartPenalty(states, config.entries, rng);

  // Estado do clima (atualizado a cada volta a partir do forecast)
  const weatherState: WeatherState = { wetness: 0, rainIntensity: 0 };
  // Estado da bandeira/flag
  const flagState: RaceFlagState = { flag: 'green', flagEndsAtLap: null, reason: null };
  // Pit stops já realizados (pra estratégias reativas não pararem 5x):
  const pitsTaken = new Map<string, number>(states.map(s => [s.driverId, 0]));

  const lapLog: LapLogEntry[] = [];

  for (let lap = 1; lap <= config.track.laps; lap++) {
    // 1. Atualiza clima
    updateWeather(weatherState, config.weather, lap, rng);

    // 2. Atualiza flag (encerra SC/VSC se for hora)
    if (flagState.flagEndsAtLap !== null && lap > flagState.flagEndsAtLap) {
      lapLog.push({ lap, standings: [], events: [`L${lap}: Bandeira verde — ${flagState.flag === 'safetyCar' ? 'SC' : 'VSC'} encerrado`] });
      flagState.flag = 'green';
      flagState.flagEndsAtLap = null;
      flagState.reason = null;
    }

    simulateLap(lap, config, states, weatherState, flagState, pitsTaken, rng, lapLog);
  }

  const finishOrder = [...states].sort((a, b) => {
    if (a.retired && !b.retired) return 1;
    if (!a.retired && b.retired) return -1;
    if (a.retired && b.retired) return b.lapsCompleted - a.lapsCompleted;
    return a.totalTime - b.totalTime;
  });

  return { finishOrder, lapLog, totalLaps: config.track.laps };
}

// =====================================================================
// CLIMA — interpola entre os pontos do forecast
// =====================================================================
function updateWeather(state: WeatherState, forecast: WeatherForecast | undefined, lap: number, rng: RNG): void {
  if (!forecast || forecast.changes.length === 0) {
    state.wetness = 0;
    state.rainIntensity = 0;
    return;
  }

  // Encontra os dois pontos do forecast em volta da volta atual
  const sorted = [...forecast.changes].sort((a, b) => a.lap - b.lap);
  let before = sorted[0]!;
  let after = sorted[sorted.length - 1]!;
  for (let i = 0; i < sorted.length - 1; i++) {
    if (sorted[i]!.lap <= lap && sorted[i + 1]!.lap >= lap) {
      before = sorted[i]!;
      after = sorted[i + 1]!;
      break;
    }
  }

  if (lap <= before.lap) {
    state.wetness = before.wetness;
  } else if (lap >= after.lap) {
    state.wetness = after.wetness;
  } else {
    // Interpolação linear
    const span = after.lap - before.lap;
    const t = (lap - before.lap) / span;
    state.wetness = before.wetness + (after.wetness - before.wetness) * t;
  }

  // Adiciona ruído pela incerteza (chuva chega antes/depois do esperado)
  if (forecast.uncertainty > 0) {
    const noise = rng.gaussian(0, forecast.uncertainty * 0.15);
    state.wetness = Math.max(0, Math.min(1, state.wetness + noise));
  }

  // rainIntensity = derivada (quão rápido tá molhando agora)
  state.rainIntensity = state.wetness;
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
  weather: WeatherState,
  flag: RaceFlagState,
  pitsTaken: Map<string, number>,
  rng: RNG,
  lapLog: LapLogEntry[],
): void {
  const events: string[] = [];

  // Snapshot da ordem no INÍCIO da volta (pra cálculos consistentes).
  const startOfLapOrder = [...states]
    .filter(s => !s.retired)
    .sort((a, b) => a.totalTime - b.totalTime);
  const snapshotTimes = new Map(startOfLapOrder.map(s => [s.driverId, s.totalTime]));

  // Se há SC/VSC ativo, multiplicador de tempo
  const flagMultiplier = flag.flag === 'safetyCar' ? SC_LAP_TIME_MULTIPLIER
    : flag.flag === 'vsc' ? VSC_LAP_TIME_MULTIPLIER
    : 1.0;

  for (let i = 0; i < startOfLapOrder.length; i++) {
    const state = startOfLapOrder[i]!;
    const entry = config.entries.find(e => e.driver.id === state.driverId)!;

    // -- Gap pra carro à frente
    const aheadSnapshot = i > 0 ? snapshotTimes.get(startOfLapOrder[i - 1]!.driverId)! : null;
    const ownSnapshot = snapshotTimes.get(state.driverId)!;
    const gapAhead = aheadSnapshot !== null ? ownSnapshot - aheadSnapshot : Infinity;

    state.energy.overtakeAvailable = gapAhead < 1.0 && gapAhead >= 0;

    const deployBudgetThisLap = planEnergyDeploy(state, entry.car);
    const sectorDeploys = distributeDeployAcrossSectors(deployBudgetThisLap, config.track.sectors);

    let trafficPenaltyTotal = 0;
    if (gapAhead >= 0 && gapAhead < 1.0) {
      trafficPenaltyTotal = (1.0 - gapAhead) * 0.4;
    } else if (gapAhead >= 1.0 && gapAhead < 2.0) {
      trafficPenaltyTotal = (2.0 - gapAhead) * 0.1;
    }
    const trafficPerSector = trafficPenaltyTotal / 3;

    // SIMULA OS 3 SETORES
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
        weather,
        rng,
      };
      const t = calculateSectorTime(ctx);
      sectorTimes[sIdx] = t;
      lapTime += t;

      const harvestThisSector = computeHarvest(state.energy.mode, sector, entry.car);
      totalHarvested += harvestThisSector;
    }

    // Aplica multiplicador de SC/VSC
    lapTime *= flagMultiplier;
    sectorTimes[0] *= flagMultiplier;
    sectorTimes[1] *= flagMultiplier;
    sectorTimes[2] *= flagMultiplier;

    // ATUALIZA ESTADO
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

    // -- EVENTOS: falha mecânica?
    if (flag.flag === 'green') {  // não checa eventos sob bandeira
      const reliabilityFactor = (100 - entry.car.performance.reliability) / 100;
      const failureProb = BASE_MECHANICAL_FAILURE_PROB * (0.3 + reliabilityFactor * 2);
      if (rng.chance(failureProb)) {
        state.retired = true;
        const causes = ['motor', 'transmissão', 'suspensão', 'eletrônica', 'hidráulica', 'bateria'];
        const cause = causes[Math.floor(rng.next() * causes.length)]!;
        state.retirementReason = cause;
        events.push(`💥 L${lap}: ${entry.driver.name} ABANDONA — falha de ${cause}`);
        // Falha mecânica tem chance de gerar SC (debris, óleo)
        if (rng.chance(0.30) && flag.flag === 'green') {
          flag.flag = 'vsc';
          flag.flagEndsAtLap = lap + 2;
          flag.reason = `Carro parado: ${entry.driver.name}`;
          events.push(`🚨 L${lap}: VSC — ${flag.reason}`);
        }
        continue;
      }

      // Erro de piloto: spin / escapada (não retira, mas perde tempo)
      // Probabilidade aumenta com baixa consistência e em chuva
      const consistencyFactor = (100 - entry.driver.attributes.consistency) / 100;
      const wetFactor = weather.wetness * (1 - entry.driver.attributes.wetSkill / 100);
      const errorProb = BASE_DRIVER_ERROR_PROB * (1 + consistencyFactor * 3 + wetFactor * 4);
      if (rng.chance(errorProb)) {
        const lostTime = 3 + rng.next() * 8; // 3-11s perdidos
        state.totalTime += lostTime;
        events.push(`⚠️  L${lap}: ${entry.driver.name} comete erro — perde ${lostTime.toFixed(1)}s`);
      }
    }

    // -- ESTRATÉGIA REATIVA: pit não planejado?
    const reactivePit = decideReactivePit(state, entry, weather, flag, pitsTaken.get(state.driverId) ?? 0);
    if (reactivePit) {
      const pitCost = config.track.pitLaneLossSeconds *
        (flag.flag === 'safetyCar' || flag.flag === 'vsc' ? SC_PIT_LANE_DISCOUNT : 1);
      state.totalTime += pitCost;
      state.tire = { compound: reactivePit, laps: 0 };
      pitsTaken.set(state.driverId, (pitsTaken.get(state.driverId) ?? 0) + 1);
      events.push(`🔧 L${lap}: ${entry.driver.name} pit reativo → ${reactivePit.toUpperCase()}`);
    } else {
      // PIT STOP planejado
      const pitStop = entry.pitStops.find(p => p.lap === lap);
      if (pitStop) {
        const pitCost = config.track.pitLaneLossSeconds *
          (flag.flag === 'safetyCar' || flag.flag === 'vsc' ? SC_PIT_LANE_DISCOUNT : 1);
        state.totalTime += pitCost;
        state.tire = { compound: pitStop.newCompound, laps: 0 };
        if (pitStop.newEnergyMode) state.energy.mode = pitStop.newEnergyMode;
        pitsTaken.set(state.driverId, (pitsTaken.get(state.driverId) ?? 0) + 1);
        events.push(`L${lap}: ${entry.driver.name} parou nos boxes — ${pitStop.newCompound.toUpperCase()}`);
      }
    }

    // -- ULTRAPASSAGEM: só sob bandeira verde
    if (flag.flag === 'green' && i > 0 && gapAhead >= 0 && gapAhead < 1.0) {
      const ahead = startOfLapOrder[i - 1]!;
      if (ahead.retired) continue;
      const aheadEntry = config.entries.find(e => e.driver.id === ahead.driverId)!;
      const passResult = tryOvertake(state, entry, ahead, aheadEntry, config.track, rng);
      if (passResult.passed) {
        state.totalTime = ahead.totalTime - 0.15;
        events.push(`L${lap}: ${entry.driver.name} ultrapassa ${aheadEntry.driver.name}`);
        // Risco de colisão durante tentativa intensa
        if (rng.chance(COLLISION_RISK_BASE * (1 - entry.driver.attributes.racecraft / 100))) {
          state.totalTime += 4;
          ahead.totalTime += 6;
          events.push(`💢 L${lap}: contato leve entre ${entry.driver.name} e ${aheadEntry.driver.name}`);
        }
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
// ESTRATÉGIA REATIVA: decide trocar pneu fora do plano
// =====================================================================
function decideReactivePit(
  state: CarRaceState,
  entry: RaceEntry,
  weather: WeatherState,
  flag: RaceFlagState,
  alreadyPitted: number,
): Compound | null {
  const strategy = entry.reactiveStrategy;
  if (!strategy) return null;

  const tire = state.tire.compound;
  const w = weather.wetness;
  const isSlick = tire === 'soft' || tire === 'medium' || tire === 'hard';
  const isInter = tire === 'intermediate';
  const isWet = tire === 'wet';

  // Pista molhando: troca pra inter ou wet
  if (isSlick && strategy.pitToWetIfWetnessAbove !== undefined && w >= strategy.pitToWetIfWetnessAbove) {
    return 'wet';
  }
  if (isSlick && strategy.pitToIntermediateIfWetnessAbove !== undefined && w >= strategy.pitToIntermediateIfWetnessAbove) {
    return 'intermediate';
  }
  if (isInter && strategy.pitToWetIfWetnessAbove !== undefined && w >= strategy.pitToWetIfWetnessAbove) {
    return 'wet';
  }

  // Pista secando: troca pra slick
  if ((isInter || isWet) && strategy.pitToDryIfWetnessBelow !== undefined && w <= strategy.pitToDryIfWetnessBelow) {
    return 'medium';
  }
  if (isWet && strategy.pitToIntermediateIfWetnessAbove !== undefined && w < strategy.pitToIntermediateIfWetnessAbove) {
    return 'intermediate';
  }

  return null;
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
