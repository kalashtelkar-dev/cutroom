/**
 * Shapes returned by the editor API's node catalogue.
 *
 * These are hand-written because they are the contract we program against;
 * `catalogue.generated.ts` carries the data and the string-literal unions
 * that are only knowable by asking the server.
 */

/** A JSON Schema subset: enough to validate operation params before submitting. */
export interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: readonly unknown[];
  default?: unknown;
  items?: JsonSchema;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  description?: string;
  additionalProperties?: boolean | JsonSchema;
  [key: string]: unknown;
}

export interface InPort {
  name: string;
  /** Port types this input will accept. Empty means it takes anything. */
  accepts: string[];
  required: boolean;
  summary?: string;
  /**
   * True when this input collects many values into one list.
   *
   * This is the other half of the iteration story: a multi-valued output
   * wired into a `list: true` input COLLAPSES instead of iterating. It is
   * how `ffmpeg/concat.inputs` joins a fan-out back together.
   */
  list?: boolean;
}

/** A param that may be driven by a wire instead of typed in. */
export interface BindablePort {
  name: string;
  accepts: string[];
  required: boolean;
  summary?: string;
}

export interface OutPort {
  name: string;
  type: string;
  /** JSONPath-ish selector into the job result the value is read from. */
  select?: string;
  summary?: string;
  /**
   * Whether this port carries many values.
   *
   * This is the single most consequential field in the catalogue: a `true`
   * port wired into a scalar input is the ONLY form of iteration the graph
   * compiler has. `"depends"` means the arity is decided by a param, and
   * has to be resolved with the node's actual params, see `fansOut()`.
   */
  list: boolean | 'depends';
}

export interface NodeSpec {
  engine: string;
  operation: string;
  summary: string;
  gpu: boolean;
  local: boolean;
  in: InPort[];
  out: OutPort[];
  /** Full JSON Schema for this node's params. */
  params: JsonSchema;
  /** Params that may be driven by a wire instead of a literal. */
  bindable: BindablePort[];
}

export interface Catalogue {
  portTypes: string[];
  count: number;
  nodes: NodeSpec[];
}
