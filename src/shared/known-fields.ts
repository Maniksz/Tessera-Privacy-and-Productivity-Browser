/**
 * A stored shape as this build knows it: the output of a schema that keeps unknown fields, without
 * the `[key: string]: unknown` that keeping them adds.
 *
 * ## What it is for
 *
 * Every store schema keeps fields it does not know (`z.looseObject`), so that a field a newer Tessera
 * added survives an older one saving the file. Zod types that as an index signature on every object,
 * and TypeScript will not assign an `interface` to a type with one — so the two-way drift checks beside
 * each schema would fail for a reason that has nothing to do with drift. This takes the index signature
 * off, recursively, and leaves everything else: a field the schema has and the interface lacks, or the
 * reverse, still fails the check it always failed.
 *
 * Only an index signature of `unknown` is removed. A `z.record(z.string(), z.number())` is a real
 * index signature with a real value type and stays exactly as it is.
 *
 * Type-only, like `ipc/same-shape.ts`, so it costs nothing at runtime and can be imported from both
 * `shared` and `main`.
 */
export type KnownFields<T> = T extends (infer E)[]
  ? KnownFields<E>[]
  : T extends readonly (infer E)[]
    ? readonly KnownFields<E>[]
    : T extends object
      ? {
          [K in keyof T as string extends K ? (unknown extends T[K] ? never : K) : K]: KnownFields<
            T[K]
          >
        }
      : T
