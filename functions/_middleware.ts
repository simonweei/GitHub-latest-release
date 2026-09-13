import { handle, type Env } from '../src/app';
export const onRequest: PagesFunction<Env> = context => handle(context.request, context.env, () => context.next());
