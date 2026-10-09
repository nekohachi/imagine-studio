// ワーカーとのやり取り。送る、種類ごとに受ける、id つきの往復。
import type { FromWorker, ToWorker } from "./protocol";

type Handler<K extends FromWorker["type"]> = (m: Extract<FromWorker, { type: K }>) => void;

export class Bridge {
  readonly worker: Worker;
  private handlers = new Map<string, Set<(m: FromWorker) => void>>();
  private pending = new Map<number, (m: FromWorker) => void>();
  private nextId = 1;

  constructor() {
    this.worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (e: MessageEvent<FromWorker>) => {
      const m = e.data;
      const id = (m as { id?: number }).id;
      if (typeof id === "number" && this.pending.has(id)) {
        this.pending.get(id)!(m);
        this.pending.delete(id);
      }
      for (const h of this.handlers.get(m.type) ?? []) h(m);
    };
  }

  send(m: ToWorker, transfer: Transferable[] = []): void {
    this.worker.postMessage(m, transfer);
  }

  on<K extends FromWorker["type"]>(type: K, fn: Handler<K>): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    const h = fn as (m: FromWorker) => void;
    set.add(h);
    return () => set!.delete(h);
  }

  /** id を振って送り、同じ id の返事を待つ。 */
  request<K extends FromWorker["type"]>(make: (id: number) => ToWorker, _type: K): Promise<Extract<FromWorker, { type: K }>> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, (m) => resolve(m as Extract<FromWorker, { type: K }>));
      this.send(make(id));
    });
  }

  onError(fn: (msg: string) => void): void {
    this.on("error", (m) => fn(m.message));
    this.worker.onerror = (e) => fn(String(e.message ?? e));
  }
}
