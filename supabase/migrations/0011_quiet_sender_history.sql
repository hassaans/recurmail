-- The sender no longer writes a heartbeat row for a run that claimed nothing
-- and sent no notices, except for the daily keepalive. Remove the idle rows
-- written before that change.
delete from public.sender_heartbeats
where claimed_count = 0
  and sent_count = 0
  and failed_count = 0
  and deferred_count = 0
  and notices_sent = 0
  and notices_failed = 0;

-- pg_net gives up on a request after 5 seconds by default. A cold start of
-- send-due can take longer, which recorded a timeout even though the run
-- finished. Allow 30 seconds. cron.schedule replaces a job with the same name.
select cron.schedule(
  'recurmail-send-due-every-minute',
  '* * * * *',
  $job$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/send-due',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-recurmail-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'sender_cron_secret')
      ),
      body := jsonb_build_object('source', 'pg_cron'),
      timeout_milliseconds := 30000
    );
  $job$
);

select cron.schedule(
  'recurmail-daily-keepalive',
  '17 3 * * *',
  $job$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/send-due',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-recurmail-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'sender_cron_secret')
      ),
      body := jsonb_build_object('source', 'daily_keepalive'),
      timeout_milliseconds := 30000
    );
  $job$
);

-- pg_cron logs every run in cron.job_run_details and never prunes it. The
-- minute job adds 1,440 rows a day, so keep one week of history.
select cron.schedule(
  'recurmail-prune-cron-history',
  '41 3 * * *',
  $job$
    delete from cron.job_run_details where end_time < now() - interval '7 days';
  $job$
);
