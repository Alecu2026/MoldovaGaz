/**
 * Creează (sau actualizează parola) unui utilizator în colecția `users`.
 *   npm run seed:user                          → test@gmail.com / parola123
 *   npm run seed:user -- alt@exemplu.md Parola  → alt cont
 * Nu atinge nicio altă colecție.
 */
import { connectMongo } from "../lib/mongo-core";
import { hashPassword } from "../lib/password";

async function main() {
  process.loadEnvFile(".env.local");
  const [email = "test@gmail.com", password = "parola123", name = "Utilizator test"] = process.argv.slice(2);
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL lipsește din .env.local");

  const client = await connectMongo(url);
  try {
    const users = client.db().collection(process.env.USERS_COLLECTION || "users");
    await users.createIndex({ email: 1 }, { unique: true });
    const passwordHash = await hashPassword(password);
    const res = await users.updateOne(
      { email: email.toLowerCase() },
      { $set: { passwordHash, name, disabled: false, updatedAt: new Date() }, $setOnInsert: { email: email.toLowerCase(), createdAt: new Date() } },
      { upsert: true },
    );
    console.log(res.upsertedCount ? `Utilizator creat: ${email}` : `Parola utilizatorului ${email} a fost actualizată.`);
  } finally {
    await client.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
