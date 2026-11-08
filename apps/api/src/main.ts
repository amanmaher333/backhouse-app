import { SwaggerModule } from '@nestjs/swagger';
import { buildOpenApi, createApp } from './bootstrap.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const app = await createApp(config);
SwaggerModule.setup('docs', app, buildOpenApi(app));
await app.listen(config.PORT);
console.log(`BOH API listening on http://localhost:${config.PORT} (docs at /docs)`);
