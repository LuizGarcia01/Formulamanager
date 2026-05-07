import type { Track, Car, Driver, CompoundProfile } from './types.js';

// =====================================================================
// PERFIS DE PNEU (Pirelli 2026 — números aproximados pra balanceamento)
// =====================================================================
export const COMPOUND_PROFILES: Record<string, CompoundProfile> = {
  soft:   { compound: 'soft',   paceOffset: -0.65, degPerLap: 0.045, cliffLap: 18 },
  medium: { compound: 'medium', paceOffset:  0.00, degPerLap: 0.022, cliffLap: 28 },
  hard:   { compound: 'hard',   paceOffset:  0.45, degPerLap: 0.014, cliffLap: 40 },
};

// =====================================================================
// PISTA: IMOLA (Autodromo Enzo e Dino Ferrari)
// =====================================================================
// Volta de referência ~1:16.5. 63 voltas. Dificuldade alta de ultrapassagem.
// Setor 1: largada → Tamburello → Villeneuve (alta velocidade, peso aero/power)
// Setor 2: Tosa → Piratella → Acque Minerali (técnico, mecânica importa)
// Setor 3: Variante Alta → Rivazza (mix, frenagens fortes — boa pra harvest)
// =====================================================================
export const IMOLA: Track = {
  id: 'imola',
  name: 'Imola',
  laps: 63,
  pitLaneLossSeconds: 23.0,
  overtakingDifficulty: 0.75,
  scProbabilityPerLap: 0.012,
  baseTireWearMultiplier: 1.05,
  sectors: [
    {
      index: 1,
      baseTime: 26.5,
      aeroWeight: 0.40, powerWeight: 0.40, mechWeight: 0.20,
      harvestPotential: 1.2,    // frenagens médias na Tamburello/Villeneuve
      deployBenefit: 0.18,      // 0.18s ganhos por MJ deployado aqui
    },
    {
      index: 2,
      baseTime: 28.0,
      aeroWeight: 0.35, powerWeight: 0.20, mechWeight: 0.45,
      harvestPotential: 1.6,    // muita frenagem no setor técnico
      deployBenefit: 0.10,      // pouco proveito de potência
    },
    {
      index: 3,
      baseTime: 22.0,
      aeroWeight: 0.30, powerWeight: 0.30, mechWeight: 0.40,
      harvestPotential: 1.4,
      deployBenefit: 0.14,
    },
  ],
};

// =====================================================================
// EQUIPES E CARROS (números 0–100, baseline 2026 fictício)
// =====================================================================
// Filosofia: top team ~92, midfield ~80, fundo ~70. Diferença total ~22 pts
// que se traduz em ~1.5–2.0s de pace puro entre o melhor e o pior carro.
// =====================================================================
export const CARS: Car[] = [
  {
    teamId: 'rb', teamName: 'Red Bull',
    performance: { aero: 92, powerICE: 90, powerBattery: 88, mechanical: 91, reliability: 86 },
    batteryCapacity: 4.0, weight: 768,
  },
  {
    teamId: 'mcl', teamName: 'McLaren',
    performance: { aero: 94, powerICE: 88, powerBattery: 89, mechanical: 90, reliability: 88 },
    batteryCapacity: 4.0, weight: 768,
  },
  {
    teamId: 'fer', teamName: 'Ferrari',
    performance: { aero: 89, powerICE: 91, powerBattery: 87, mechanical: 88, reliability: 84 },
    batteryCapacity: 4.0, weight: 770,
  },
  {
    teamId: 'mer', teamName: 'Mercedes',
    performance: { aero: 87, powerICE: 89, powerBattery: 91, mechanical: 88, reliability: 90 },
    batteryCapacity: 4.0, weight: 768,
  },
  {
    teamId: 'aud', teamName: 'Audi',
    performance: { aero: 80, powerICE: 84, powerBattery: 85, mechanical: 82, reliability: 78 },
    batteryCapacity: 4.0, weight: 772,
  },
  {
    teamId: 'ast', teamName: 'Aston Martin',
    performance: { aero: 82, powerICE: 81, powerBattery: 80, mechanical: 84, reliability: 82 },
    batteryCapacity: 4.0, weight: 770,
  },
  {
    teamId: 'wil', teamName: 'Williams',
    performance: { aero: 78, powerICE: 82, powerBattery: 79, mechanical: 78, reliability: 80 },
    batteryCapacity: 4.0, weight: 772,
  },
  {
    teamId: 'sau', teamName: 'Sauber',
    performance: { aero: 73, powerICE: 76, powerBattery: 74, mechanical: 75, reliability: 76 },
    batteryCapacity: 4.0, weight: 775,
  },
];

// =====================================================================
// PILOTOS (8 fictícios pra protótipo — nomes e valores ilustrativos)
// =====================================================================
export const DRIVERS: Driver[] = [
  // Top tier
  { id: 'd01', name: 'Max V.',    attributes: { pace: 96, consistency: 94, tireManagement: 92, energyManagement: 95, attack: 95, defense: 94, racecraft: 96, wetSkill: 95 } },
  { id: 'd02', name: 'Lando N.',  attributes: { pace: 93, consistency: 91, tireManagement: 90, energyManagement: 88, attack: 92, defense: 89, racecraft: 91, wetSkill: 87 } },
  // Strong
  { id: 'd03', name: 'Charles L.', attributes: { pace: 94, consistency: 86, tireManagement: 84, energyManagement: 87, attack: 91, defense: 88, racecraft: 89, wetSkill: 90 } },
  { id: 'd04', name: 'George R.',  attributes: { pace: 91, consistency: 90, tireManagement: 88, energyManagement: 90, attack: 87, defense: 88, racecraft: 90, wetSkill: 88 } },
  // Midfield
  { id: 'd05', name: 'Oscar P.',   attributes: { pace: 90, consistency: 89, tireManagement: 87, energyManagement: 86, attack: 86, defense: 87, racecraft: 87, wetSkill: 84 } },
  { id: 'd06', name: 'Carlos S.',  attributes: { pace: 88, consistency: 87, tireManagement: 88, energyManagement: 85, attack: 86, defense: 86, racecraft: 88, wetSkill: 85 } },
  // Lower
  { id: 'd07', name: 'Alex A.',    attributes: { pace: 84, consistency: 84, tireManagement: 82, energyManagement: 80, attack: 82, defense: 83, racecraft: 84, wetSkill: 80 } },
  { id: 'd08', name: 'Gabriel B.', attributes: { pace: 78, consistency: 75, tireManagement: 74, energyManagement: 72, attack: 78, defense: 75, racecraft: 74, wetSkill: 78 } },
];
