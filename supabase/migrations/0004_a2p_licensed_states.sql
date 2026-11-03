-- completeRegistration (shared/a2pProgram.ts) writes A2PRegistration.licensed_states, which the Base44 jsonc
-- never declared (Base44 stored it anyway). Declared here so the entity adapter keeps it.
alter table public.a2p_registration add column if not exists "licensed_states" jsonb;
