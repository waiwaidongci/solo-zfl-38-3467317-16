// JSON 文件存储：原子写（临时文件 + rename）+ 按绳索互斥锁 + 写盘故障注入
import { mkdir, readFile, writeFile, rename, rm, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, basename, join } from "node:path";

const seed = { ropes: [] };

// 持久化失败专用错误：只携带稳定错误码，绝不包含路径或系统错误细节。
export class PersistError extends Error {
  constructor(code) {
    super(code);
    this.name = "PersistError";
    this.code = code; // "write_failed" | "rename_failed"
  }
}

export class JsonStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.dir = dirname(filePath);
    this.tails = new Map(); // key -> Promise 链尾（串行化同一根绳索上的变更）
    this.failNextWrites = 0; // 故障注入：接下来 N 次“写临时文件”抛错
    this.tmpSeq = 0;
  }

  // 本库临时文件名（basename 严格前缀，避免误碰同目录其他数据库的文件）
  _tmpPath() {
    this.tmpSeq += 1;
    return `${this.filePath}.tmp-${process.pid}-${this.tmpSeq}`;
  }
  static isTempFor(filePath, name) {
    return name.startsWith(`${basename(filePath)}.tmp-`);
  }

  // 启动时清理本库遗留临时文件：只认本库 basename 前缀，不碰其他数据库。
  async cleanStaleTempFiles() {
    let names = [];
    try {
      names = await readdir(this.dir);
    } catch {
      return; // 目录尚不存在，首次 load 会创建
    }
    await Promise.all(
      names
        .filter((n) => JsonStore.isTempFor(this.filePath, n))
        .map((n) => rm(join(this.dir, n), { force: true }).catch(() => {}))
    );
  }

  async load() {
    await this.cleanStaleTempFiles();
    if (!existsSync(this.filePath)) {
      await mkdir(this.dir, { recursive: true });
      await this.atomicWrite(JSON.stringify(seed, null, 2));
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

  // 原子持久化：先写同目录唯一临时文件再 rename。
  // 任一步失败都清掉本次临时文件，原库文件保持不动；错误不含路径/系统细节。
  async persist() {
    if (this.failNextWrites > 0) {
      this.failNextWrites -= 1;
      throw new PersistError("write_failed");
    }
    await this.atomicWrite(JSON.stringify(this.db, null, 2));
  }

  async atomicWrite(snapshot) {
    const tmp = this._tmpPath();
    let wrote = false;
    try {
      await writeFile(tmp, snapshot, "utf8");
      wrote = true;
      await rename(tmp, this.filePath);
    } catch {
      // 临时文件已落盘则务必删掉；删除本身再失败也吞掉（不掩盖原始错误）。
      if (wrote) await rm(tmp, { force: true }).catch(() => {});
      throw new PersistError(wrote ? "rename_failed" : "write_failed");
    }
  }

  async reset() {
    this.db = { ropes: [] };
    await this.persist();
  }
}
