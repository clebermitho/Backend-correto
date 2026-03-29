import NodeCache from 'node-cache';

export const cache = new NodeCache({ stdTTL: 300 }); // 5 min default TTL
