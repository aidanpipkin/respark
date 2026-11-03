// Ported from legacy_base44/functions/adminDiagnostics/entry.ts; the handler is unchanged apart from imports.
import { serve } from '../_shared/runtime.ts';
import handler from './handler.ts';

serve(handler);
