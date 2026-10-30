-- =====================================================================
-- Kicker+ : abonnements, limites de la version gratuite, verrou groupes
-- =====================================================================

-- ---------- 1. Verrou sur les groupes ------------------------------------
-- Avant : n'importe quel membre pouvait réécrire tout le groupe
-- (createdBy, code, members). Désormais :
--   * createdBy et code ne changent jamais ;
--   * on ne peut ajouter que soi-même (join_group) ;
--   * on peut se retirer soi-même ; seul l'organisateur retire les autres.
create or replace function public.kicker_group_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  me text := (auth.uid())::text;
  old_m jsonb := coalesce(old.data -> 'members', '{}'::jsonb);
  new_m jsonb := coalesce(new.data -> 'members', '{}'::jsonb);
  k text;
begin
  if me is null then return new; end if;  -- service role / tâches serveur
  if (new.data ->> 'createdBy') is distinct from (old.data ->> 'createdBy') then
    raise exception 'KICKER_FORBIDDEN: organisateur non modifiable';
  end if;
  if coalesce(new.code, new.data ->> 'code') is distinct from coalesce(old.code, old.data ->> 'code') then
    raise exception 'KICKER_FORBIDDEN: code non modifiable';
  end if;
  for k in select jsonb_object_keys(new_m) loop
    if not old_m ? k and k <> me then
      raise exception 'KICKER_FORBIDDEN: ajout d''un autre membre';
    end if;
  end loop;
  for k in select jsonb_object_keys(old_m) loop
    if not new_m ? k and k <> me and (old.data ->> 'createdBy') <> me then
      raise exception 'KICKER_FORBIDDEN: seul l''organisateur retire un membre';
    end if;
  end loop;
  return new;
end $$;

drop trigger if exists kicker_group_guard on public.groups;
create trigger kicker_group_guard before update on public.groups
  for each row execute function public.kicker_group_guard();

-- ---------- 2. Abonnements -----------------------------------------------
create table if not exists public.subscriptions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  stripe_customer_id text unique,
  stripe_subscription_id text unique,
  status text not null default 'none',          -- active, trialing, past_due, canceled, ...
  plan text,                                   -- month | year
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  updated_at timestamptz not null default now()
);
alter table public.subscriptions enable row level security;
drop policy if exists subs_read_own on public.subscriptions;
create policy subs_read_own on public.subscriptions for select using (user_id = auth.uid());
-- Aucune écriture côté client : seul le webhook Stripe (service role) écrit.

create or replace function public.is_plus(p_uid text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.subscriptions s
    where s.user_id::text = p_uid
      and s.status in ('active', 'trialing', 'past_due')
      and (s.current_period_end is null or s.current_period_end > now() - interval '3 days'));
$$;

-- Un groupe est « Kicker+ » si son organisateur est abonné.
create or replace function public.group_is_plus(p_gid text)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select public.is_plus(g.data ->> 'createdBy') from public.groups g where g.id = p_gid), false);
$$;

-- Ce que l'app lit au démarrage.
create or replace function public.kicker_plan()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'plus', public.is_plus((auth.uid())::text),
    'status', s.status, 'plan', s.plan,
    'until', s.current_period_end, 'cancel', coalesce(s.cancel_at_period_end, false),
    'plusGroups', coalesce((
      select jsonb_agg(g.id) from public.groups g
      where g.data -> 'members' ? (auth.uid())::text
        and public.is_plus(g.data ->> 'createdBy')), '[]'::jsonb),
    -- Joueurs abonnés parmi ceux qui partagent un groupe avec moi (pour le badge).
    'plusUsers', coalesce((
      select jsonb_agg(distinct m.k) from public.groups g, jsonb_object_keys(g.data -> 'members') m(k)
      where g.data -> 'members' ? (auth.uid())::text and public.is_plus(m.k)), '[]'::jsonb),
    'limits', jsonb_build_object('groups', 2, 'gamesPerMonth', 4))
  from (select 1) x
  left join public.subscriptions s on s.user_id = auth.uid();
$$;

revoke execute on function public.is_plus(text) from public, anon;
revoke execute on function public.group_is_plus(text) from public, anon;
revoke execute on function public.kicker_plan() from public, anon;
grant execute on function public.is_plus(text), public.group_is_plus(text), public.kicker_plan() to authenticated;

-- ---------- 3. Limites de la version gratuite ----------------------------
-- 2 groupes créés par compte gratuit.
create or replace function public.kicker_group_limit()
returns trigger language plpgsql security definer set search_path = public as $$
declare me text := (auth.uid())::text; n int;
begin
  if me is null or public.is_plus(me) then return new; end if;
  select count(*) into n from public.groups g where g.data ->> 'createdBy' = me;
  if n >= 2 then
    raise exception 'KICKER_PLUS_GROUPS: limite de 2 groupes atteinte';
  end if;
  return new;
end $$;

drop trigger if exists kicker_group_limit on public.groups;
create trigger kicker_group_limit before insert on public.groups
  for each row execute function public.kicker_group_limit();

-- 4 soirées par mois et par groupe, sauf si l'organisateur du groupe est abonné.
-- Le mois est celui de la date de la soirée.
create or replace function public.kicker_game_limit()
returns trigger language plpgsql security definer set search_path = public as $$
declare me text := (auth.uid())::text; m text; n int;
begin
  if me is null or new.group_id is null or public.group_is_plus(new.group_id) then return new; end if;
  m := left(coalesce(nullif(new.data ->> 'date', ''), to_char(now() at time zone 'Europe/Paris', 'YYYY-MM-DD')), 7);
  select count(*) into n from public.games x
   where x.group_id = new.group_id
     and left(coalesce(nullif(x.data ->> 'date', ''), to_char(x.updated_at at time zone 'Europe/Paris', 'YYYY-MM-DD')), 7) = m;
  if n >= 4 then
    raise exception 'KICKER_PLUS_GAMES: limite de 4 soirées ce mois-ci';
  end if;
  return new;
end $$;

drop trigger if exists kicker_game_limit on public.games;
create trigger kicker_game_limit before insert on public.games
  for each row execute function public.kicker_game_limit();

-- ---------- 4. Quitter un groupe (bug existant) --------------------------
-- La mise à jour directe était refusée : une fois retiré, le joueur ne
-- « voit » plus la ligne, ce que Postgres interdit. On passe par une fonction.
create or replace function public.leave_group(p_gid text)
returns boolean language plpgsql security definer set search_path = public as $$
declare me text := (auth.uid())::text;
begin
  if me is null then return false; end if;
  update public.groups set data = jsonb_set(data, '{members}', coalesce(data -> 'members', '{}'::jsonb) - me),
         updated_at = now()
   where id = p_gid and data -> 'members' ? me and data ->> 'createdBy' <> me;
  return found;
end $$;
revoke execute on function public.leave_group(text) from public, anon;
grant execute on function public.leave_group(text) to authenticated;
