export async function resolve(specifier, context, next) {
  if (specifier.includes('@langchain')) throw Error('HEAVY_GRAPH_ENGINE_ON_HOST: '+specifier);
  return next(specifier, context);
}
