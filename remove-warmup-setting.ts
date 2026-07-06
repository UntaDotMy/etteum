import { db } from './src/db';
import { settings } from './src/db/schema';
import { eq } from 'drizzle-orm';

await db.delete(settings).where(eq(settings.key, 'auto_warmup_provider_alibaba'));
console.log('Removed auto_warmup_provider_alibaba setting');
