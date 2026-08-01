// Minimal ambient stub standing in for a third-party ORM (Prisma, TypeORM,
// ...): a method SIGNATURE only, no implementation body — exactly the shape
// every real npm package's `.d.ts` has. PLAN §6: calls into `node_modules`
// are out of scope and must never be traversed by the call graph.
declare module 'third-party-orm' {
  export class Repository {
    findOne(id: string): string;
  }
}
