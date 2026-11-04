-- Allow transactional mail kinds beyond the original three (SP-06).
ALTER TABLE outbox_messages
  DROP CONSTRAINT IF EXISTS outbox_messages_kind_check;

ALTER TABLE outbox_messages
  ADD CONSTRAINT outbox_messages_kind_check CHECK (
    kind IN (
      'alert',
      'subscription_verification',
      'subscriber_notification',
      'member_invite',
      'plan_upgraded',
      'account_welcome',
      'password_reset',
      'admin_access'
    )
  );

-- alert_id required only for kind = alert (keep existing rule if present)
ALTER TABLE outbox_messages
  DROP CONSTRAINT IF EXISTS outbox_messages_alert_link;

ALTER TABLE outbox_messages
  ADD CONSTRAINT outbox_messages_alert_link CHECK (
    (kind = 'alert') = (alert_id IS NOT NULL)
  );
