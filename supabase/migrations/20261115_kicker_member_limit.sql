-- =====================================================================
-- Kicker+ : 7 membres maximum par groupe en version gratuite
-- (illimité si l'organisateur du groupe est abonné à Kicker+)
-- =====================================================================

create or replace function public.kicker_member_limit()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  n_new int := (select count(*) from jsonb_object_keys(coalesce(new.data -> 'members', '{}'::jsonb)));
  n_old int := 0;
begin
  if tg_op = 'UPDATE' then
    n_old := (select count(*) from jsonb_object_keys(coalesce(old.data -> 'members', '{}'::jsonb)));
  end if;
  -- On ne bloque que les ajouts : un groupe déjà au-dessus de la limite garde ses membres.
  if n_new > 7 and n_new > n_old
     and not public.is_plus(new.data ->> 'createdBy') then
    raise exception 'KICKER_PLUS_MEMBERS: ce groupe est complet (7 membres maximum en version gratuite)';
  end if;
  return new;
end $$;

drop trigger if exists kicker_member_limit on public.groups;
create trigger kicker_member_limit before insert or update on public.groups
  for each row execute function public.kicker_member_limit();

-- Ce que l'app lit au démarrage : on ajoute la limite de membres.
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
    'plusUsers', coalesce((
      select jsonb_agg(distinct m.k) from public.groups g, jsonb_object_keys(g.data -> 'members') m(k)
      where g.data -> 'members' ? (auth.uid())::text and public.is_plus(m.k)), '[]'::jsonb),
    'limits', jsonb_build_object('groups', 2, 'gamesPerMonth', 4, 'members', 7))
  from (select 1) x
  left join public.subscriptions s on s.user_id = auth.uid();
$$;
