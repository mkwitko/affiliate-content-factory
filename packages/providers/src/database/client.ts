import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client.js";

export const createDatabaseClient = (connectionString: string): PrismaClient => {
  const adapter = new PrismaPg({ connectionString });
  return new PrismaClient({ adapter });
};

export type DatabaseClient = PrismaClient;
