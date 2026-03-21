import { INFERENCE_FEATURE_KEYS } from "../config.js";

const NUMERIC_CELL_PATTERN = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;

function parseCsvLine(line) {
  const values = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];

    if (char === '"') {
      const next = line[index + 1];
      if (inQuotes && next === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      values.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  if (inQuotes) {
    throw new Error("The CSV has an unmatched quote.");
  }

  values.push(current.trim());
  return values;
}

function normalizeHeaderKey(header) {
  return header.trim().replace(/^[#\s]+/, "").trim();
}

function normalizeCsvCellValue(value) {
  const normalized = (value ?? "").trim();
  if (!normalized) {
    return null;
  }

  if (NUMERIC_CELL_PATTERN.test(normalized)) {
    const numeric = Number(normalized);
    if (Number.isFinite(numeric)) {
      return numeric;
    }
  }

  return normalized;
}

function parseCsvTable(text) {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!normalized) {
    throw new Error("Upload a CSV with at least one header row and one data row.");
  }

  const lines = normalized
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length < 2) {
    throw new Error("Use a CSV with one header row and at least one data row.");
  }

  const headers = parseCsvLine(lines[0]);
  if (!headers.length) {
    throw new Error("The CSV header row is empty.");
  }

  const dataLines = lines.slice(1);
  const rows = dataLines.map((line) => {
    const values = parseCsvLine(line);

    if (headers.length !== values.length) {
      throw new Error("The CSV header and data rows do not have the same number of columns.");
    }

    return headers.reduce((record, header, index) => {
      const key = normalizeHeaderKey(header);
      if (!key) {
        throw new Error("The CSV contains an empty column name.");
      }

      if (Object.hasOwn(record, key)) {
        throw new Error(`The CSV contains duplicate column name '${key}' after normalization.`);
      }

      record[key] = normalizeCsvCellValue(values[index] ?? "");
      return record;
    }, {});
  });

  return {
    headers,
    rows,
  };
}

export function parseSingleRowCsv(text) {
  const table = parseCsvTable(text);
  if (table.rows.length !== 1) {
    throw new Error("Use a CSV with exactly one header row and one data row.");
  }

  return table.rows[0];
}

export function parseTopCsvRow(text) {
  const table = parseCsvTable(text);
  return {
    csvRow: table.rows[0],
    headerCount: table.headers.length,
    dataRowCount: table.rows.length,
    selectedRowIndex: 0,
  };
}

export function buildInferenceInputs(csvRow) {
  const inputs = {};

  INFERENCE_FEATURE_KEYS.forEach((key) => {
    inputs[key] = csvRow[key] ?? null;
  });

  Object.entries(csvRow).forEach(([key, value]) => {
    if (!(key in inputs)) {
      inputs[key] = value;
    }
  });

  return inputs;
}
