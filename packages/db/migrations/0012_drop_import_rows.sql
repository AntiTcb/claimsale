-- Contract step for 0006 (expand): the engine stopped writing import_rows when item imports
-- moved to io_jobs / io_job_rows (WS-G, 0008). No deployed code reads or writes it.
DROP TABLE `import_rows`;
