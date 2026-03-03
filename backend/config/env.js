import dotenv from 'dotenv';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let loaded = false;

export function loadEnv() {
    if (loaded) return;

    const backendRoot = join(__dirname, '..');
    const nodeEnv = process.env.NODE_ENV || 'development';
    const initialKeys = new Set(Object.keys(process.env));

    function loadFromFile(filePath, allowFileOverride = false) {
        if (!existsSync(filePath)) return;

        const parsed = dotenv.config({
            path: filePath,
            quiet: true,
        }).parsed || {};

        for (const [key, value] of Object.entries(parsed)) {
            if (initialKeys.has(key)) continue;
            if (allowFileOverride || process.env[key] === undefined) {
                process.env[key] = value;
            }
        }
    }

    const defaultEnvPath = join(backendRoot, '.env');
    loadFromFile(defaultEnvPath, false);

    const envSpecificPath = join(backendRoot, `.env.${nodeEnv}`);
    loadFromFile(envSpecificPath, true);

    loaded = true;
}
