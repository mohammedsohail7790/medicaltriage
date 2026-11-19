-- NFR-145: inactivity timeout needs the time of the last user activity per session.
ALTER TABLE "user_sessions" ADD COLUMN "last_activity_at" TIMESTAMP(3);
