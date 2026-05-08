import { simulateRace } from './engine.js';
import { IMOLA, CARS, DRIVERS } from './data.js';
import type { RaceConfig, RaceEntry } from './types.js';

// =====================================================================
// CENÁRIO: IMOLA COM CHUVA CHEGANDO
// =====================================================================
// Pista seca até a volta 18, chuva começa, atinge pico ~70% molhada na L30,
// começa a secar e está praticamente seca de novo na L55.
// Equipes com estratégia reativa decidem trocar pra inter quando passa o limiar.
// =====================================================================

const STARTING_GRID: RaceEntry[] = [
  { driver: DRIVERS[1]!, car: CARS[1]!, startCompound: 'medium', startEnergyMode: 'balanced',
    pitStops: [{ lap: 28, newCompound: 'hard' }],
    reactiveStrategy: { pitToIntermediateIfWetnessAbove: 0.40, pitToDryIfWetnessBelow: 0.20 },
  },
  { driver: DRIVERS[0]!, car: CARS[0]!, startCompound: 'medium', startEnergyMode: 'balanced',
    pitStops: [{ lap: 30, newCompound: 'hard' }],
    reactiveStrategy: { pitToIntermediateIfWetnessAbove: 0.45, pitToDryIfWetnessBelow: 0.20 },
  },
  { driver: DRIVERS[2]!, car: CARS[2]!, startCompound: 'soft', startEnergyMode: 'attack',
    pitStops: [{ lap: 16, newCompound: 'medium' }, { lap: 42, newCompound: 'medium' }],
    reactiveStrategy: { pitToIntermediateIfWetnessAbove: 0.45, pitToDryIfWetnessBelow: 0.25 },
  },
  { driver: DRIVERS[3]!, car: CARS[3]!, startCompound: 'medium', startEnergyMode: 'balanced',
    pitStops: [{ lap: 25, newCompound: 'hard' }],
    reactiveStrategy: { pitToIntermediateIfWetnessAbove: 0.50, pitToDryIfWetnessBelow: 0.20 }, // espera mais
  },
  { driver: DRIVERS[4]!, car: CARS[4]!, startCompound: 'medium', startEnergyMode: 'balanced',
    pitStops: [{ lap: 27, newCompound: 'hard' }],
    reactiveStrategy: { pitToIntermediateIfWetnessAbove: 0.40, pitToDryIfWetnessBelow: 0.20 },
  },
  { driver: DRIVERS[5]!, car: CARS[5]!, startCompound: 'soft', startEnergyMode: 'attack',
    pitStops: [{ lap: 15, newCompound: 'hard' }],
    reactiveStrategy: { pitToIntermediateIfWetnessAbove: 0.35, pitToDryIfWetnessBelow: 0.20 }, // troca cedo
  },
  { driver: DRIVERS[6]!, car: CARS[6]!, startCompound: 'medium', startEnergyMode: 'balanced',
    pitStops: [{ lap: 26, newCompound: 'hard' }],
    reactiveStrategy: { pitToIntermediateIfWetnessAbove: 0.45, pitToDryIfWetnessBelow: 0.25 },
  },
  { driver: DRIVERS[7]!, car: CARS[7]!, startCompound: 'hard', startEnergyMode: 'recharge',
    pitStops: [{ lap: 35, newCompound: 'medium' }],
    reactiveStrategy: { pitToIntermediateIfWetnessAbove: 0.55, pitToDryIfWetnessBelow: 0.20 }, // espera muito
  },
];

const config: RaceConfig = {
  track: IMOLA,
  entries: STARTING_GRID,
  seed: 42,
  weather: {
    changes: [
      { lap: 1,  wetness: 0.0 },
      { lap: 18, wetness: 0.0 },
      { lap: 22, wetness: 0.4 },
      { lap: 30, wetness: 0.7 },
      { lap: 42, wetness: 0.4 },
      { lap: 55, wetness: 0.05 },
      { lap: 63, wetness: 0.0 },
    ],
    uncertainty: 0.2,
  },
};

console.log('═'.repeat(72));
console.log(`  F1 MANAGER — Engine v0.2 (clima + eventos)`);
console.log(`  ${config.track.name.toUpperCase()} — ${config.track.laps} voltas — seed ${config.seed}`);
if (config.weather) {
  console.log(`  Clima dinamico: chuva chegando volta ~22, pico ~30, secando apos 42`);
}
console.log('═'.repeat(72));

console.log('\n📋 GRID DE LARGADA');
STARTING_GRID.forEach((e, i) => {
  const reactive = e.reactiveStrategy?.pitToIntermediateIfWetnessAbove
    ? `inter@${(e.reactiveStrategy.pitToIntermediateIfWetnessAbove * 100).toFixed(0)}%w`
    : '';
  console.log(`  P${(i + 1).toString().padStart(2)}  ${e.driver.name.padEnd(14)} ${e.car.teamName.padEnd(14)} [${e.startCompound.toUpperCase()}] ${reactive}`);
});

const result = simulateRace(config);

const KEY_LAPS = new Set([1, 15, 22, 30, 42, 55, IMOLA.laps]);
console.log('\n📊 PROGRESSO DA CORRIDA');
for (const entry of result.lapLog) {
  if (!KEY_LAPS.has(entry.lap)) continue;
  if (entry.standings.length === 0) continue;
  console.log(`\n── Volta ${entry.lap}/${IMOLA.laps} ──`);
  for (const s of entry.standings.slice(0, 5)) {
    const gap = s.position === 1 ? 'LIDER' : `+${s.gapToLeader.toFixed(2)}s`;
    const lap = formatTime(s.lapTime);
    const tire = `${s.tire.compound.padEnd(4).slice(0, 4).toUpperCase()}${s.tire.laps.toString().padStart(2)}v`;
    console.log(`  P${s.position}  ${s.driverName.padEnd(14)} ${s.teamName.padEnd(13)} ${lap}  ${gap.padStart(8)}  [${tire}]`);
  }
}

console.log('\n🎙️  EVENTOS DA CORRIDA');
const allEvents = result.lapLog.flatMap(l => l.events);
if (allEvents.length === 0) {
  console.log('  (corrida sem eventos notaveis)');
} else {
  const important = allEvents.filter(e =>
    e.includes('💥') || e.includes('🚨') || e.includes('🔧') || e.includes('💢')
    || e.includes('⚠️') || e.includes('ultrapassa') || e.includes('Bandeira')
  );
  important.slice(0, 30).forEach(e => console.log(`  ${e}`));
  if (important.length > 30) console.log(`  ...(${important.length - 30} eventos adicionais)`);
}

console.log('\n🏁 RESULTADO FINAL');
console.log('═'.repeat(72));
const winner = result.finishOrder[0];
if (winner) {
  const winnerEntry = STARTING_GRID.find(e => e.driver.id === winner.driverId)!;
  console.log(`  VENCEDOR: ${winnerEntry.driver.name} (${winnerEntry.car.teamName})`);
  console.log(`  Tempo total: ${formatTime(winner.totalTime)}\n`);
}

result.finishOrder.forEach((s, idx) => {
  const entry = STARTING_GRID.find(e => e.driver.id === s.driverId)!;
  if (s.retired) {
    console.log(`  DNF  ${entry.driver.name.padEnd(14)} ${entry.car.teamName.padEnd(14)} (volta ${s.lapsCompleted}, ${s.retirementReason ?? 'falha'})`);
  } else {
    const gap = idx === 0 ? formatTime(s.totalTime) : `+${(s.totalTime - result.finishOrder[0]!.totalTime).toFixed(2)}s`;
    console.log(`  P${(idx + 1).toString().padStart(2)}  ${entry.driver.name.padEnd(14)} ${entry.car.teamName.padEnd(14)} ${gap.padStart(14)}`);
  }
});

console.log('═'.repeat(72));

function formatTime(seconds: number): string {
  if (seconds < 90) return seconds.toFixed(3);
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
}
