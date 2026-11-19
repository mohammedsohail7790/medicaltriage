-- NFR-050: the position of each consumer of incremental extraction, per dataset.
CREATE TABLE "extraction_cursors" (
    "consumer" TEXT NOT NULL,
    "dataset" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "extraction_cursors_pkey" PRIMARY KEY ("consumer", "dataset")
);
