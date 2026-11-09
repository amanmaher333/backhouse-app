import { SwaggerModule } from '@nestjs/swagger';
import { buildOpenApi, createApp } from './bootstrap.js';
import { loadConfig } from './config.js';
import { initMonitoring } from './common/monitoring.js';

const config = loadConfig();
initMonitoring(config, 'api');
const app = await createApp(config);
SwaggerModule.setup('docs', app, buildOpenApi(app));
await app.listen(config.PORT);
console.log(`Backhouse API listening on http://localhost:${config.PORT} (docs at /docs)`);
