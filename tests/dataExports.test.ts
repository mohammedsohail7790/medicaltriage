import { DATASETS, datasetShape, decodeToken, encodeToken, ExtractionError, listDatasets, toCsv, toParquet } from "../src/services/dataExports.js";
import { parquetReadObjects } from "hyparquet";

describe("NFR-169 / NFR-050 datasets, tokens and formats", () => {
  it("describes every dataset with an ordering field and no credential columns", () => {
    for (const dataset of DATASETS) {
      const { shape } = datasetShape(dataset.name);
      expect(shape.cursor).toBeTruthy();
      const names = shape.columns.map((c) => c.name);
      expect(names).not.toEqual(expect.arrayContaining(["passwordHash"]));
      expect(names.some((n) => /ciphertext|secret|token$/i.test(n))).toBe(false);
    }
    expect(datasetShape("users").shape.columns.map((c) => c.name)).toEqual(expect.arrayContaining(["fullName", "organization"]));
    expect(datasetShape("users").shape.columns.map((c) => c.name)).not.toEqual(expect.arrayContaining(["emailCiphertext", "passwordHash"]));
  });

  it("orders audit events by sequence and mutable data by last change", () => {
    expect(datasetShape("audit-events").shape.cursor).toBe("sequenceNumber");
    expect(datasetShape("queue-items").shape.cursor).toBe("updatedAt");
    expect(datasetShape("archived-records").shape.cursor).toBe("archivedAt");
  });

  it("lists the datasets with the formats on offer", () => {
    const listed = listDatasets();
    expect(listed).toHaveLength(DATASETS.length);
    expect(listed[0].formats).toEqual(["json", "csv", "parquet"]);
  });

  it("round-trips a position token and rejects a damaged one", () => {
    const token = encodeToken({ c: "2026-11-20T10:00:00.000Z", i: "abc" });
    expect(decodeToken(token)).toEqual({ c: "2026-11-20T10:00:00.000Z", i: "abc" });
    expect(() => decodeToken("not-a-token")).toThrow(ExtractionError);
    expect(() => datasetShape("nope")).toThrow(/Unknown dataset/);
  });

  const page = {
    dataset: "demo",
    columns: [{ name: "id", type: "String" }, { name: "note", type: "String" }, { name: "count", type: "Int" }, { name: "at", type: "DateTime" }, { name: "meta", type: "Json" }, { name: "ok", type: "Boolean" }],
    rows: [
      { id: "1", note: 'He said "stop", then left', count: 3, at: new Date("2026-01-02T03:04:05.000Z"), meta: { a: 1 }, ok: true },
      { id: "2", note: null, count: null, at: null, meta: null, ok: false }
    ],
    nextToken: "t",
    hasMore: false
  };

  it("writes CSV with quoting for commas, quotes and line breaks", () => {
    const lines = toCsv(page).trimEnd().split("\n");
    expect(lines[0]).toBe("id,note,count,at,meta,ok");
    expect(lines[1]).toBe('1,"He said ""stop"", then left",3,2026-01-02T03:04:05.000Z,"{""a"":1}",true');
    expect(lines[2]).toBe("2,,,,,false");
  });

  it("writes Parquet that reads back with the same values", async () => {
    const buffer = toParquet(page);
    const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
    const rows = (await parquetReadObjects({ file: arrayBuffer })) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: "1", note: 'He said "stop", then left', count: 3, ok: true });
    expect(JSON.parse(String(rows[0].meta))).toEqual({ a: 1 });
    expect(rows[1]).toMatchObject({ id: "2", note: null, ok: false });
  });
});
