-- A task that leaves a page in a private notebook (the page is deleted, or the
-- task is removed from it) stays private: only its creator and assignee can
-- see it, instead of it becoming visible to the whole workspace as a
-- standalone task. Cleared when the task is placed in a note again.
ALTER TABLE tasks ADD COLUMN private_owner_only INTEGER NOT NULL DEFAULT 0;
