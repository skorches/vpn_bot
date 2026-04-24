-- Seed plans matching the Telegram bot plan options
INSERT INTO "plans" (id, code, title, duration_days, traffic_bytes, device_limit, is_active)
VALUES
  (gen_random_uuid()::text, '1m',  '1 мес - 299₽',   30,  21474836480,  1, true),
  (gen_random_uuid()::text, '3m',  '3 мес - 749₽',   90,  64424509440,  1, true),
  (gen_random_uuid()::text, '6m',  '6 мес - 1299₽',  180, 128849018880, 1, true),
  (gen_random_uuid()::text, '12m', '12 мес - 2299₽',  365, 257698037760, 1, true)
ON CONFLICT (code) DO NOTHING;
