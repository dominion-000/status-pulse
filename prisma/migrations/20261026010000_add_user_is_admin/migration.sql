-- Platform administrator flag (SP-08). Default false; only set deliberately.
ALTER TABLE users ADD COLUMN is_admin BOOLEAN NOT NULL DEFAULT false;
