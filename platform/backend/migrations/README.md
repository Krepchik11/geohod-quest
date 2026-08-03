# Migrations

sqlx applies these at startup and checksums every applied file.

**Applied migrations are immutable.** Once a file has run anywhere (production,
a teammate's database), editing it makes sqlx abort with a checksum mismatch on
the next start. Schema changes ship as a new file with the next number.

`0001_init.sql` predates this rule's need: its header still says "this file IS
the schema". That was true at the time and the file cannot be edited to say
otherwise — read it as historical.
