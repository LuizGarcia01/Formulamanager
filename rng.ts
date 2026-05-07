// Mulberry32: PRNG simples, rápido, com seed. Suficiente pra simulação.
// Permite que a mesma seed produza a mesma corrida, sempre.

export class RNG {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  // Float [0, 1)
  next(): number {
    this.state = (this.state + 0x6D2B79F5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  // Aproximação de gaussiana via Box–Muller. Útil pra variabilidade de pace.
  gaussian(mean: number, stdDev: number): number {
    const u1 = Math.max(this.next(), 1e-10);
    const u2 = this.next();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return mean + z * stdDev;
  }

  // Roll de probabilidade [0,1]: true se ocorrer.
  chance(probability: number): boolean {
    return this.next() < probability;
  }
}
