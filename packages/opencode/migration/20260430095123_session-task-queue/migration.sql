PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_todo` (
	`id` text NOT NULL,
	`project_id` text NOT NULL,
	`content` text NOT NULL,
	`status` text NOT NULL,
	`priority` text NOT NULL,
	`created_by` text,
	`claimed_by` text,
	`claimed_at` integer,
	`completed_by` text,
	`completed_at` integer,
	`position` integer NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `todo_pk` PRIMARY KEY(`project_id`, `id`),
	CONSTRAINT `fk_todo_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
INSERT INTO `__new_todo`(`id`, `project_id`, `content`, `status`, `priority`, `position`, `time_created`, `time_updated`) SELECT `todo`.`session_id` || ':' || `todo`.`position`, `session`.`project_id`, `todo`.`content`, `todo`.`status`, `todo`.`priority`, `todo`.`position`, `todo`.`time_created`, `todo`.`time_updated` FROM `todo` INNER JOIN `session` ON `session`.`id` = `todo`.`session_id`;--> statement-breakpoint
DROP TABLE `todo`;--> statement-breakpoint
ALTER TABLE `__new_todo` RENAME TO `todo`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `todo_project_idx` ON `todo` (`project_id`);