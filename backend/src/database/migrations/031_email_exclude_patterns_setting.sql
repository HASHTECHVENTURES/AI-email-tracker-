-- Company-wide sender blocklist (newline-separated in system_settings.value).
INSERT INTO system_settings (key, value, updated_at)
VALUES ('email_exclude_patterns', '', NOW())
ON CONFLICT (key) DO NOTHING;
