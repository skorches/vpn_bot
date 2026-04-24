-- Add 30 GiB to each plan's traffic vs original seed (20 / 60 / 120 / 240 GiB)
UPDATE "plans" SET "traffic_bytes" = 53687091200 WHERE "code" = '1m';
UPDATE "plans" SET "traffic_bytes" = 96636764160 WHERE "code" = '3m';
UPDATE "plans" SET "traffic_bytes" = 161061273600 WHERE "code" = '6m';
UPDATE "plans" SET "traffic_bytes" = 289910292480 WHERE "code" = '12m';
