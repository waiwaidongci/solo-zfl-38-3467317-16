// JSON 文件存储：原子写（临时文件 + rename）+ 按绳索互斥锁 + 写盘故障注入
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";

const seed = { ropes: [] };

export class JsonStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.tails = new Map(); // key -> Promise 链尾（串行化同一根绳索上的变更）
    this.failNextWrites = 0; // 故障注入：接下来 N 次落盘抛错
    this.tmpSeq = 0;
  }

  async load() {
    if (!existsSync(this.filePath)) {
      await mkdir(dirname(this.filePath), { recursive: true });
      await this._write(JSON.stringify(seed, null, 2));
    }
    const db = JSON.parse(await readFile(this.filePath, "utf8"));
    if (!Array.isArray(db.ropes)) db.ropes = []; // 兼容旧版（items）数据文件
    this.db = db;
    return db;
  }

  // 串行化同一把 key（如同一根绳索）上的变更；不同 key 可并行。
  // 返回给调用者的 promise 会正常抛错；存入链尾的 promise 永不 reject，
  // 以免“失败路径”产生无人处理的 unhandledRejection。
  async withLock(key, fn) {
    const prev = this.tails.get(key) || Promise.resolve();
    const gate = prev.then(() => {}, () => {});
    const next = gate.then(fn);
    const tail = next.then(
      () => cleanup(),
      () => cleanup()
    );
    const cleanup = () => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    };
    this.tails.set(key, tail);
    return next;
  }

  // 一次按序取多把锁（排序避免死锁），全部成功才执行；任一 fn 抛错则整体抛出。
  async withLocks(keys, fn) {
    const ordered = [...new Set(keys)].sort();
    const run = (i) =>
      i === ordered.length ? fn() : this.withLock(ordered[i], () => run(i + 1));
    return run(0);
  }

  // 原子持久化：先写同目录唯一临时文件再 rename，失败不留半截数据文件。
  async persist() {
    if (this.failNextWrites > 0) {
      this.failNextWrites -= 1;
      throw new Error("injected_write_failure");
    }
    await this._write(JSON.stringify(this.db, null, 2));
  }

  async _write(snapshot) {
    this.tmpSeq += 1;
    const tmp = `${this.filePath}.tmp-${process.pid}-${this.tmpSeq}`;
    await writeFile(tmp, snapshot, "utf8");
    await rename(tmp, this.filePath);
  }

  async reset() {
    this.db = { ropes: [] };
    await this.persist();
  }
}
