// =====================================================================
// F1 MANAGER — CORE TYPES (regulamento 2026)
// =====================================================================
// Todos os tempos em segundos. Energia em MJ. Massa em kg.
// =====================================================================

// --------- PISTA ---------
export interface Sector {
  index: 1 | 2 | 3;
  baseTime: number;           // tempo de referência do setor (carro ref, pneu novo, sem tráfego)
  // Quanto cada característica do carro pesa NESTE setor (somam ~1.0):
  aeroWeight: number;         // peso do downforce
  powerWeight: number;        // peso do motor (ICE + bateria)
  mechWeight: number;         // peso do mecânico (suspensão, freio, tração)
  // Energia:
  harvestPotential: number;   // MJ que dá pra recuperar neste setor (frenagens)
  deployBenefit: number;      // segundos ganhos por MJ deployado neste setor
}

export interface Track {
  id: string;
  name: string;
  laps: number;
  pitLaneLossSeconds: number;          // tempo perdido entrando+saindo do pit
  overtakingDifficulty: number;        // 0 (Monza) a 1 (Mônaco)
  scProbabilityPerLap: number;         // prob safety car por volta (não usado ainda)
  baseTireWearMultiplier: number;      // 0.7 (suave, ex: Mônaco) a 1.4 (severo, ex: Silverstone)
  sectors: [Sector, Sector, Sector];
}

// --------- CARRO ---------
// Cada atributo é 0–100 (relativo ao melhor carro do grid).
// O cálculo de pace usa estes números ponderados pelos pesos do setor.
export interface CarPerformance {
  aero: number;
  powerICE: number;
  powerBattery: number;       // capacidade efetiva + eficiência de descarga
  mechanical: number;
  reliability: number;        // afeta probabilidade de falha (futuro)
}

export interface Car {
  teamId: string;
  teamName: string;
  performance: CarPerformance;
  batteryCapacity: number;    // MJ máximos (4.0 é o teto regulamentar comum)
  weight: number;             // kg em ordem de marcha
}

// --------- PILOTO ---------
// Atributos 0–100. Os ranges entre o melhor e o pior do grid devem ser
// percebidos: um piloto 95 vs 70 = ~0.4s de pace puro.
export interface DriverAttributes {
  pace: number;               // velocidade pura
  consistency: number;        // baixa variância volta-a-volta
  tireManagement: number;     // reduz desgaste
  energyManagement: number;   // segue mapas de energia / decisões de Boost
  attack: number;             // ultrapassagem
  defense: number;            // segurar posição
  racecraft: number;          // decisões em geral, leitura de corrida
  wetSkill: number;           // chuva (não usado ainda)
}

export interface Driver {
  id: string;
  name: string;
  attributes: DriverAttributes;
}

// --------- PNEU ---------
export type Compound = 'soft' | 'medium' | 'hard' | 'intermediate' | 'wet';

export type DryCompound = 'soft' | 'medium' | 'hard';
export type WetCompound = 'intermediate' | 'wet';

export interface CompoundProfile {
  compound: Compound;
  // Pace bruto vs médio em pneu novo (segundos por volta):
  // soft = -0.7, medium = 0, hard = +0.4
  paceOffset: number;
  // Curva de degradação: tempo perdido por volta de uso, antes de "cliff".
  // Valor por volta usada (acumula).
  degPerLap: number;
  // Volta em que o pneu "cai do penhasco" (cliff) — degradação acelera 3x.
  cliffLap: number;
}

export interface TireState {
  compound: Compound;
  laps: number;               // voltas rodadas com este pneu
}

// --------- ENERGIA (2026) ---------
export interface EnergyState {
  battery: number;            // MJ atuais na bateria
  // Modo de energia escolhido pela equipe pra esta volta:
  mode: EnergyMode;
  // "Overtake" mode: ativo quando o carro entra na volta a <1s do da frente,
  // dá +0.5 MJ extra disponível pra deploy nesta volta.
  overtakeAvailable: boolean;
}

export type EnergyMode =
  | 'recharge'    // prioriza recarga, deploy mínimo (gerencia bateria)
  | 'balanced'   // padrão
  | 'attack';    // deploy máximo, sacrifica recarga

// --------- ESTADO DE CORRIDA ---------
export interface CarRaceState {
  driverId: string;
  carId: string;
  position: number;           // 1..N
  totalTime: number;          // tempo acumulado de corrida (s)
  lapsCompleted: number;
  tire: TireState;
  energy: EnergyState;
  fuelKg: number;             // peso de combustível restante
  retired: boolean;
  retirementReason?: string;
  // Histórico de volta (debug/UI futuro):
  lastLapTime: number | null;
  lastSectorTimes: [number, number, number] | null;
}

export interface RaceConfig {
  track: Track;
  entries: RaceEntry[];        // grid de largada (na ordem)
  seed: number;                // pra reproduzibilidade
  weather?: WeatherForecast;   // se omitido, corrida seca o tempo todo
}

// --------- CLIMA ---------
// 0 = pista totalmente seca, 1 = pista totalmente encharcada
// Valor parcial (0.3 = umidade leve, 0.6 = molhada, 0.9 = muito molhada)
export interface WeatherForecast {
  // Eventos de mudança de clima por volta. Entre eventos, transição linear.
  // Ex: [{lap:1, wetness:0}, {lap:20, wetness:0.7}, {lap:35, wetness:0.2}]
  // = pista seca até L20, chuva chegando, secando depois
  changes: WeatherChange[];
  // Variabilidade da previsão: 0 = exato, 1 = totalmente incerto
  // Aplicado como ruído nas voltas em que a chuva chega
  uncertainty: number;
}

export interface WeatherChange {
  lap: number;                 // volta em que atinge esse nível
  wetness: number;             // 0..1
}

export interface WeatherState {
  wetness: number;             // 0..1, estado atual da pista
  rainIntensity: number;       // 0..1, intensidade ATUAL da chuva caindo
}

// --------- ESTADO DA CORRIDA ---------
export interface RaceFlagState {
  flag: 'green' | 'yellow' | 'safetyCar' | 'vsc' | 'red';
  flagEndsAtLap: number | null;  // volta em que termina (null se não definida)
  reason: string | null;
}

export interface RaceEntry {
  driver: Driver;
  car: Car;
  startCompound: Compound;
  startEnergyMode: EnergyMode;
  pitStops: PitStop[];         // estratégia pré-definida; quando vazio, sem paradas
  // Estratégia reativa: regras que podem disparar pit não planejado
  reactiveStrategy?: ReactiveStrategy;
}

export interface ReactiveStrategy {
  // Trocar pneus se chover acima desse nível e ainda estiver com slick
  pitToIntermediateIfWetnessAbove?: number;  // ex: 0.4
  // Trocar pra wet se acima desse nível
  pitToWetIfWetnessAbove?: number;           // ex: 0.75
  // Trocar pra slick se pista secar abaixo desse nível
  pitToDryIfWetnessBelow?: number;           // ex: 0.25
  // Pit oportunista durante safety car (ganha mais barato)
  pitUnderSafetyCar?: boolean;
}

export interface PitStop {
  lap: number;                 // volta em que para (entra ao final da volta)
  newCompound: Compound;
  newEnergyMode?: EnergyMode;  // opcional; se omitido, mantém modo atual
}

export interface RaceResult {
  finishOrder: CarRaceState[];
  lapLog: LapLogEntry[];       // log volta-a-volta pra debug
  totalLaps: number;
}

export interface LapLogEntry {
  lap: number;
  // Ordem na linha de chegada da volta, com gap pro líder:
  standings: Array<{
    position: number;
    driverName: string;
    teamName: string;
    gapToLeader: number;      // segundos
    lapTime: number;
    sectorTimes: [number, number, number];
    tire: TireState;
    battery: number;
  }>;
  events: string[];            // ultrapassagens, defesas, etc.
}
