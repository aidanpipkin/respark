// Ported from legacy_base44/functions/health/entry.ts; the handler is unchanged apart from imports.
import { serve } from '../_shared/runtime.ts';
import handler from './handler.ts';

serve(handler);
