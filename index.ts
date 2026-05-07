import { simulateRace } from './engine.js';
import { IMOLA, CARS, DRIVERS } from './data.js';
import type { RaceConfig, RaceEntry, Compound } from './types.js';

// =====================================================================
// MONTAGEM DO GRID
// =====================================================================
// Pareia 1 piloto por equipe (8 pilotos × 8 equipes = 8 carros pra simplicidade).
// Grid de largada é por ordem deste array (não há quali ainda).
// =====================================================================

const STARTING_GRID: RaceEntry[] = [
  // Pole position
  { driver: DRIVERS[1]!, car: CARS[1]!, startCompound: 'medium', startEnergyMode: 'balanced',
    pitStops: [{ lap: 28, newCompound: 'hard' }] },
  { driver: DRIVERS[0]!, car: CARS[0]!, startCompound: 'medium', startEnergyMode: 'balanced',
    pitStops: [{ lap: 30, newCompound: 'hard' }] },
  { driver: DRIVERS[2]!, car: CARS[2]!, startCompound: 'soft',   startEnergyMode: 'attack',
    pitStops: [{ lap: 16, newCompound: 'medium' }, { lap: 42, newCompound: 'medium' }] },
  { driver: DRIVERS[3]!, car: CARS[3]!, startCompound: 'medium', startEnergyMode: 'balanced',
    pitStops: [{ lap: 25, newCompound: 'hard' }] },
  { driver: DRIVERS[4]!, car: CARS[4]!, startCompound: 'medium', startEnergyMode: 'balanced',
    pitStops: [{ lap: 27, newCompound: 'hard' }] },
  { driver: DRIVERS[5]!, car: CARS[5]!, startCompound: 'soft',   startEnergyMode: 'attack',
    pitStops: [{ lap: 15, newCompound: 'hard' }] },
  { driver: DRIVERS[6]!, car: CARS[6]!, startCompound: 'medium', startEnergyMode: 'balanced',
    pitStops: [{ lap: 26, newCompound: 'hard' }] },
  { driver: DRIVERS[7]!, car: CARS[7]!, startCompound: 'hard',   startEnergyMode: 'recharge',
    pitStops: [{ lap: 35, newCompound: 'medium' }] },
];

const config: RaceConfig = {
  track: IMOLA,
  entries: STARTING_GRID,
  seed: 42,
};

// =====================================================================
// RUN
// =====================================================================

console.log('═'.repeat(72));
console.log(`  F1 MANAGER — Engine v0.1`);
console.log(`  ${config.track.name.toUpperCase()} — ${config.track.laps} voltas — seed ${config.seed}`);
console.log('═'.repeat(72));

console.log('\n📋 GRID DE LARGADA');
STARTING_GRID.forEach((e, i) => {
  console.log(`  P${(i + 1).toString().padStart(2)}  ${e.driver.name.padEnd(14)} ${e.car.teamName.padEnd(14)} [${e.startCompound.toUpperCase()}] mode:${e.startEnergyMode}`);
});

const result = simulateRace(config);

// Mostrar voltas-chave: 1, 15, 30, 45, última
const KEY_LAPS = new Set([1, 15, 30, 45, IMOLA.laps]);
console.log('\n📊 PROGRESSO DA CORRIDA (voltas-chave)');
for (const entry of result.lapLog) {
  if (!KEY_LAPS.has(entry.lap)) continue;
  console.log(`\n── Volta ${entry.lap}/${IMOLA.laps} ──`);
  for (const s of entry.standings) {
    const gap = s.position === 1 ? 'LIDER' : `+${s.gapToLeader.toFixed(2)}s`;
    const lap = formatTime(s.lapTime);
    const tire = `${s.tire.compound[0]?.toUpperCase()}${s.tire.laps.toString().padStart(2)}v`;
    const bat = `${(s.battery).toFixed(1)}MJ`;
    console.log(`  P${s.position}  ${s.driverName.padEnd(14)} ${s.teamName.padEnd(14)} ${lap}  ${gap.padStart(8)}  [${tire}] [${bat}]`);
  }
}

// Eventos da corrida
console.log('\n🎙️  EVENTOS NOTÁVEIS');
const allEvents = result.lapLog.flatMap(l => l.events);
if (allEvents.length === 0) {
  console.log('  (nenhuma ultrapassagem registrada)');
} else {
  // Mostra primeiras 15 e últimas 5
  const toShow = allEvents.length <= 20 ? allEvents : [...allEvents.slice(0, 15), '  ...', ...allEvents.slice(-5)];
  toShow.forEach(e => console.log(`  ${e}`));
  if (allEvents.length > 20) console.log(`  (total: ${allEvents.length} eventos)`);
}

// Resultado final
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
    console.log(`  DNF  ${entry.driver.name.padEnd(14)} ${entry.car.teamName.padEnd(14)} (volta ${s.lapsCompleted})`);
  } else {
    const gap = idx === 0 ? formatTime(s.totalTime) : `+${(s.totalTime - result.finishOrder[0]!.totalTime).toFixed(2)}s`;
    console.log(`  P${(idx + 1).toString().padStart(2)}  ${entry.driver.name.padEnd(14)} ${entry.car.teamName.padEnd(14)} ${gap.padStart(14)}`);
  }
});

console.log('═'.repeat(72));

// =====================================================================
function formatTime(seconds: number): string {
  if (seconds < 90) return seconds.toFixed(3);
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
}
