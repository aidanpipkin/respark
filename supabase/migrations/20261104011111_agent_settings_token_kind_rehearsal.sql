-- The built-in rehearsal workspace stores token_kind = 'rehearsal' (never declared in the jsonc enum).
alter table public.agent_settings drop constraint if exists agent_settings_token_kind_check;
alter table public.agent_settings add constraint agent_settings_token_kind_check check ("token_kind" is null or "token_kind" in ('pit', 'oauth', 'rehearsal'));
