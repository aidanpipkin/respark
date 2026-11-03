// Microsoft 365 calendar connection (start / callback / status). New in the Supabase port; see docs/LEGACY_RESPARK_FOLD_IN.md.
import { serve } from '../_shared/runtime.ts';
import handler from './handler.ts';

serve(handler);
