#!/bin/sh
# Runs the case's verification flow against the Docker Compose stack and says,
# step by step, what was checked and whether it held.
#
#   docker compose run --rm verify --help     (only Docker needed)
#   scripts/verify.sh --help                  (from this machine: Docker and curl)
set -u
cd "$(dirname "$0")/.."

API=${API:-http://localhost:13400}
RUN=$(date +%s | tail -c 6)
USER_ID="reviewer-$RUN"
FAILED=0

usage() {
  cat <<'EOF'
Checks the case's verification flow on the running stack (docker compose up -d).

Usage: docker compose run --rm verify [--user <id>] <check>...
       scripts/verify.sh [--user <id>] <check>...      (same, from this machine)

Checks:
  all          every check below except export, one after another
  credits      a summary of "merhaba" completes and costs 3 credits (10 -> 7)
  repeat       the same request twice is one job, charged once; the same key
               with a different text is refused (422)
  fail         the provider refuses the text: the job fails, credits come back
  flaky        the provider fails twice, then answers: done on the third try
  hang         the provider never answers: three 10-second timeouts, then the
               job fails and credits come back (takes about 35 seconds)
  same-text    20 jobs with the same text: the provider is asked only once
  limit        30 different jobs: never more than 4 provider calls at once
  crash        the worker is killed in the middle of a job and started again:
               the job still completes and is charged once
  balances     every balance matches its credit history
  export       a 500,000-job CSV read slowly: memory stays flat, and stopping
               the download stops the database work (creates the 500,000 jobs
               first if they are missing, about 2 minutes)

Options:
  --user <id>  user to run the checks as (default: a new one for every run)
  --help       show this text

Every check starts with its own credits and its own texts, so checks can run
in any order and again. The exit code is 0 only if every check held.
EOF
}

# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

title() { printf '\n%s\n' "$1"; }
note() { printf '   %s\n' "$1"; }
pass() { printf '   \342\234\224 %s\n' "$1"; }
fail() {
  printf '   \342\234\230 %s\n' "$1"
  FAILED=$((FAILED + 1))
}
# check <condition result 0/1> <message when it holds> <message when it does not>
check() { if [ "$1" -eq 0 ]; then pass "$2"; else fail "$3"; fi; }

# ---------------------------------------------------------------------------
# API, database and logs (nothing here is printed)
# ---------------------------------------------------------------------------

# post_job <key> <type> <text>: prints the response body.
post_job() {
  curl -s -X POST "$API/v1/jobs" -H "X-User-Id: $USER_ID" -H "Idempotency-Key: $RUN-$1" \
    -H 'Content-Type: application/json' -d "{\"type\":\"$2\",\"input\":\"$3\"}"
}
get_job() { curl -s "$API/v1/jobs/$1" -H "X-User-Id: $USER_ID"; }
grant() {
  curl -s -o /dev/null -X POST "$API/internal/users/$USER_ID/credits" -H 'Content-Type: application/json' \
    -d "{\"amount\":$1}"
}
balance() { curl -s "$API/internal/users/$USER_ID/credits" | field balance; }

# field <name>: reads a top-level field from the JSON on stdin.
field() { sed -E "s/.*\"$1\":\"?([^\",}]*)\"?.*/\1/"; }

# wait_for <jobId> <seconds>: waits until the job is finished; prints its status.
wait_for() {
  waited=0
  while :; do
    status=$(get_job "$1" | field status)
    case "$status" in completed | failed) break ;; esac
    [ "$waited" -ge "$2" ] && break
    sleep 1
    waited=$((waited + 1))
  done
  printf '%s' "$status"
}

sql() {
  docker compose exec -T postgres sh -c 'psql -X -q -At -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "$1"' psql "$1"
}

# logs_since <service> <timestamp>: the service's log lines, without colours.
ESC=$(printf '\033')
logs_since() { docker compose logs --no-log-prefix --since "$2" "$1" 2>/dev/null | sed "s/$ESC\[[0-9;]*m//g"; }
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# ---------------------------------------------------------------------------
# Checks
# ---------------------------------------------------------------------------

check_credits() {
  title '1. A summary costs 3 credits'
  grant 10
  before=$(balance)
  job=$(post_job credits summary merhaba | field jobId)
  note "Added 10 credits and asked for a summary of \"merhaba\" (job $job)."
  status=$(wait_for "$job" 30)
  result=$(get_job "$job" | field result)
  after=$(balance)
  check "$([ "$status" = completed ] && echo 0 || echo 1)" "The job completed: \"$result\"" "The job did not complete (status: $status)"
  check "$([ $((before - after)) -eq 3 ] && echo 0 || echo 1)" "Balance went from $before to $after" "Balance went from $before to $after, expected 3 less"
}

check_repeat() {
  title '2. The same request twice is one job, charged once'
  grant 10
  first=$(post_job repeat summary 'repeat test' | field jobId)
  wait_for "$first" 30 >/dev/null
  before=$(balance)
  second=$(post_job repeat summary 'repeat test' | field jobId)
  after=$(balance)
  note "Sent the same request twice with the same Idempotency-Key."
  check "$([ "$first" = "$second" ] && echo 0 || echo 1)" "Both answers name the same job ($first)" "The answers name different jobs ($first, $second)"
  check "$([ "$before" -eq "$after" ] && echo 0 || echo 1)" "Nothing was charged for the repeat (balance unchanged: $after)" "The repeat changed the balance ($before -> $after)"
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/v1/jobs" -H "X-User-Id: $USER_ID" \
    -H "Idempotency-Key: $RUN-repeat" -H 'Content-Type: application/json' -d '{"type":"summary","input":"other text"}')
  check "$([ "$code" = 422 ] && echo 0 || echo 1)" "The same key with a different text was refused (422)" "The same key with a different text got $code, expected 422"
}

check_fail() {
  title '3. The provider refuses the text: the job fails and the credits come back'
  grant 10
  before=$(balance)
  job=$(post_job fail summary "fail deneme $RUN" | field jobId)
  status=$(wait_for "$job" 30)
  error=$(get_job "$job" | field errorCode)
  after=$(balance)
  check "$([ "$status" = failed ] && echo 0 || echo 1)" "The job failed ($error)" "The job did not fail (status: $status)"
  check "$([ "$before" -eq "$after" ] && echo 0 || echo 1)" "The 3 credits came back (balance $after)" "Balance went from $before to $after"
}

check_flaky() {
  title '4. The provider fails twice, then answers: done on the third try'
  grant 10
  since=$(now)
  job=$(post_job flaky translate "flaky deneme $RUN" | field jobId)
  status=$(wait_for "$job" 30)
  tries=$(logs_since worker "$since" | grep "$job" | grep -o 'JOB_CLAIMED.*attempt: [0-9]*' | grep -o '[0-9]*$' | tr '\n' ' ')
  check "$([ "$status" = completed ] && echo 0 || echo 1)" "The job completed" "The job did not complete (status: $status)"
  check "$([ "$tries" = '1 2 3 ' ] && echo 0 || echo 1)" "The worker log shows three tries: ${tries% }" "The worker log shows tries: ${tries:-none}"
}

check_hang() {
  title '5. The provider never answers: three timeouts, then the job fails'
  note 'This takes about 35 seconds.'
  grant 10
  before=$(balance)
  job=$(post_job hang translate "hang deneme $RUN" | field jobId)
  started=$(date +%s)
  status=$(wait_for "$job" 60)
  took=$(($(date +%s) - started))
  error=$(get_job "$job" | field errorCode)
  after=$(balance)
  check "$([ "$status" = failed ] && [ "$error" = provider_timeout ] && echo 0 || echo 1)" "The job failed after $took seconds ($error)" "Status $status, error $error"
  check "$([ "$before" -eq "$after" ] && echo 0 || echo 1)" "The credit came back (balance $after)" "Balance went from $before to $after"
}

check_same_text() {
  title '6. Twenty jobs with the same text: the provider is asked only once'
  grant 30
  text="ayni metin $RUN"
  for i in $(seq 20); do post_job "same-$i" translate "$text" >/dev/null & done
  wait
  sleep 3
  counts=$(sql "SELECT count(*) FILTER (WHERE j.result_source = 'provider'), count(*) FILTER (WHERE j.status = 'completed'),
                       (SELECT count(*) FROM user_credit_ledger l JOIN jobs x ON x.id = l.job_id
                         WHERE x.job_content_id = c.id AND l.entry_type = 'capture')
                  FROM jobs j JOIN job_contents c ON c.id = j.job_content_id
                 WHERE c.input = '$text' GROUP BY c.id")
  calls=$(echo "$counts" | cut -d'|' -f1)
  done_count=$(echo "$counts" | cut -d'|' -f2)
  charged=$(echo "$counts" | cut -d'|' -f3)
  check "$([ "$calls" = 1 ] && echo 0 || echo 1)" "The provider was called once; the other 19 jobs shared its answer" "Provider calls: ${calls:-?}"
  check "$([ "$done_count" = 20 ] && [ "$charged" = 20 ] && echo 0 || echo 1)" "All 20 jobs completed and each was charged" "Completed: ${done_count:-?}, charged: ${charged:-?}"
}

check_limit() {
  title '7. Thirty different jobs: never more than 4 provider calls at once'
  grant 40
  since=$(now)
  for i in $(seq 30); do post_job "limit-$i" translate "metin $i $RUN" >/dev/null & done
  wait
  sleep 8
  highest=$(logs_since worker "$since" | grep -o 'maxConcurrent: [0-9]*' | grep -o '[0-9]*$' | sort -n | tail -1)
  check "$([ "${highest:-0}" -ge 1 ] && [ "${highest:-0}" -le 4 ] && echo 0 || echo 1)" "Highest number of calls at once in the worker log: $highest" "Highest number of calls at once: ${highest:-none seen}"
}

check_crash() {
  title '8. The worker is killed in the middle of a job'
  grant 10
  job=$(post_job crash summary "slow deneme $RUN" | field jobId)
  waited=0
  until [ "$(get_job "$job" | field status)" = processing ] || [ "$waited" -ge 30 ]; do
    sleep 1
    waited=$((waited + 1))
  done
  note "The job is being processed; killing the worker and starting it again."
  docker compose kill worker >/dev/null 2>&1
  docker compose start worker >/dev/null 2>&1
  started=$(date +%s)
  status=$(wait_for "$job" 90)
  took=$(($(date +%s) - started))
  entries=$(sql "SELECT string_agg(entry_type || ' ' || n, ', ' ORDER BY entry_type) FROM
                   (SELECT entry_type, count(*) AS n FROM user_credit_ledger WHERE job_id = '$job' GROUP BY 1) t")
  check "$([ "$status" = completed ] && echo 0 || echo 1)" "The job was not lost: it completed $took seconds after the restart" "Status after the restart: $status"
  check "$([ "$entries" = 'reserve 1, capture 1' ] && echo 0 || echo 1)" "It was charged exactly once (credit history: $entries)" "Credit history: $entries"
}

check_balances() {
  title '9. Every balance matches its credit history'
  wrong=$(sql "SELECT count(*) FROM users u WHERE (balance, reserved) <> (
                 SELECT coalesce(sum(CASE entry_type WHEN 'grant' THEN amount WHEN 'reserve' THEN -amount
                                                     WHEN 'release' THEN amount ELSE 0 END), 0),
                        coalesce(sum(CASE entry_type WHEN 'reserve' THEN amount ELSE -amount END)
                                   FILTER (WHERE entry_type <> 'grant'), 0)
                   FROM user_credit_ledger l WHERE l.user_id = u.id)")
  users=$(sql "SELECT count(*) FROM users")
  check "$([ "$wrong" = 0 ] && echo 0 || echo 1)" "Balances and reserved credits add up from the credit history (users checked: $users)" "$wrong of $users users do not add up"
}

check_export() {
  title '10. Exporting 500,000 jobs to a slow reader'
  if [ "$(sql "SELECT count(*) >= 500000 FROM jobs WHERE user_id = 'seed-user'")" != t ]; then
    note 'Creating 500,000 jobs for "seed-user" first (about 2 minutes).'
    docker compose run --rm seed >/dev/null 2>&1
  fi
  app=$(docker compose ps -q app)
  # A fresh process grows V8's young generation once, to suit the allocation
  # rate, while the live heap stays flat (design.md section 12). Sampled
  # during that, a flat profile reads as growth; a short full-speed export
  # reaches the working size first, as any memory benchmark warms up.
  note 'Warming up with 5 seconds at full speed, so the app reaches its working memory first.'
  curl -s --max-time 5 -H 'X-User-Id: seed-user' "$API/v1/jobs/export.csv" -o /dev/null
  sleep 2
  since=$(now)
  curl -s --limit-rate 50k -H 'X-User-Id: seed-user' "$API/v1/jobs/export.csv" -o /dev/null &
  download=$!
  note 'Downloading at 50 KB/s; app memory every 5 seconds:'
  samples=''
  for _ in 1 2 3 4 5 6; do
    sleep 5
    memory=$(docker stats --no-stream --format '{{.MemUsage}}' "$app" | cut -d' ' -f1)
    samples="$samples $memory"
  done
  note "  $samples"
  { kill "$download" && wait "$download"; } 2>/dev/null
  sleep 2
  low=$(echo "$samples" | tr ' ' '\n' | grep MiB | sed 's/MiB//' | sort -n | head -1)
  high=$(echo "$samples" | tr ' ' '\n' | grep MiB | sed 's/MiB//' | sort -n | tail -1)
  steady=$(awk -v low="${low:-0}" -v high="${high:-0}" 'BEGIN { print (low > 0 && high - low < 20) ? 0 : 1 }')
  check "$steady" "Memory stayed flat while rows streamed (${low}-${high} MiB)" "Memory moved from ${low:-?} to ${high:-?} MiB"
  aborted=$(logs_since app "$since" | grep -c JOB_EXPORT_ABORTED)
  running=$(sql "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()
                   AND state = 'active' AND pid <> pg_backend_pid() AND query ILIKE '%FROM \"public\".\"jobs\"%'")
  check "$([ "$aborted" -ge 1 ] && [ "$running" = 0 ] && echo 0 || echo 1)" "Stopping the download stopped the export; no query is left running" "Export stopped: $aborted, queries still running: $running"
}

# ---------------------------------------------------------------------------

CHECKS='credits repeat fail flaky hang same-text limit crash balances export all'

run() {
  case "$1" in
    credits) check_credits ;;
    repeat) check_repeat ;;
    fail) check_fail ;;
    flaky) check_flaky ;;
    hang) check_hang ;;
    same-text) check_same_text ;;
    limit) check_limit ;;
    crash) check_crash ;;
    balances) check_balances ;;
    export) check_export ;;
    all) for name in credits repeat fail flaky hang same-text limit crash balances; do run "$name"; done ;;
  esac
}

checks=''
while [ $# -gt 0 ]; do
  case "$1" in
    -h | --help | help)
      usage
      exit 0
      ;;
    --user)
      USER_ID=$2
      shift 2
      ;;
    *)
      checks="$checks $1"
      shift
      ;;
  esac
done
if [ -z "$checks" ]; then
  usage
  exit 0
fi
for name in $checks; do
  case " $CHECKS " in
    *" $name "*) ;;
    *)
      printf 'Unknown check: %s\n\n' "$name"
      usage
      exit 2
      ;;
  esac
done

if [ "$(curl -s -o /dev/null -w '%{http_code}' "$API/health")" != 200 ]; then
  printf 'The API at %s does not answer. Start the stack first: docker compose up -d\n' "$API"
  exit 2
fi
printf 'Running as user "%s" against %s\n' "$USER_ID" "$API"
for name in $checks; do run "$name"; done

if [ "$FAILED" -eq 0 ]; then
  printf '\nAll checks held.\n'
else
  printf '\n%s check(s) did not hold.\n' "$FAILED"
  exit 1
fi
