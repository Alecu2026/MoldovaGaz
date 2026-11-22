import "server-only";
import type { Collection, Db, Document, MongoClient } from "mongodb";
import { connectMongo } from "./mongo-core";

/**
 * Singleton MongoDB (supraviețuiește HMR din dev: stă pe globalThis) + indecși creați o singură dată pe proces.
 * Numele colecțiilor se pot schimba din env (USERS_COLLECTION / SESSIONS_COLLECTION / METERS_COLLECTION) — util pentru teste pe o colecție separată.
 */
export const COLLECTIONS = {
  users: process.env.USERS_COLLECTION || "users",
  sessions: process.env.SESSIONS_COLLECTION || "sessions",
  /** contoarele reale (scrise de scripts/sync-meters.ts) */
  meters: process.env.METERS_COLLECTION || "meters",
};

const g = globalThis as unknown as { __mgClient?: Promise<MongoClient>; __mgIndexes?: Promise<void> };

function client(): Promise<MongoClient> {
  if (!g.__mgClient) {
    const url = process.env.DATABASE_URL;
    if (!url) return Promise.reject(new Error("DATABASE_URL lipsește (vezi .env.local)."));
    g.__mgClient = connectMongo(url).catch((e) => {
      g.__mgClient = undefined; // la următoarea cerere încercăm din nou
      throw e;
    });
  }
  return g.__mgClient;
}

export async function getDb(): Promise<Db> {
  const db = (await client()).db();
  g.__mgIndexes ??= ensureIndexes(db).catch((e) => {
    g.__mgIndexes = undefined;
    throw e;
  });
  await g.__mgIndexes;
  return db;
}

async function ensureIndexes(db: Db) {
  await Promise.all([
    db.collection(COLLECTIONS.users).createIndex({ email: 1 }, { unique: true }),
    db.collection(COLLECTIONS.sessions).createIndex({ tokenHash: 1 }, { unique: true }),
    db.collection(COLLECTIONS.sessions).createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    // contoare: delta după updatedAt, capul listei după ultima citire
    db.collection(COLLECTIONS.meters).createIndex({ updatedAt: -1 }),
    db.collection(COLLECTIONS.meters).createIndex({ "s.t": -1 }),
    // (colecția veche `uplinks`, mesajele brute din ingest, nu mai e folosită)
  ]);
}

export async function col<T extends Document = Document>(name: string): Promise<Collection<T>> {
  return (await getDb()).collection<T>(name);
}
