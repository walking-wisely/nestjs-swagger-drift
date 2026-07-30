// A local barrel re-exporting `@nestjs/common`/`@nestjs/swagger` — a common
// real-world pattern (teams centralize imports through an internal
// `nest-shared` package). `provenance.ts`'s `checkProvenance` must follow
// the alias chain through this barrel's `export *` all the way back to the
// ambient module declaration, not just one hop.
export * from '@nestjs/common';
export * from '@nestjs/swagger';
