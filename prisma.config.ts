import { config } from 'dotenv';
import { expand } from 'dotenv-expand';
import { defineConfig } from 'prisma/config';

// Same .env handling as the app: values may reference others, e.g. ${POSTGRES_PORT}.
expand(config({ quiet: true }));

export default defineConfig({
  schema: 'prisma/schema',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    // Optional here so `prisma generate` runs on a fresh clone without .env;
    // migrate commands still fail with a clear error when it is missing.
    url: process.env.DATABASE_URL,
  },
});
