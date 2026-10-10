// Dynamic layer over app.json. The only thing it does is let the API host be
// overridden without editing app.json:
//
//   SERVD_API_URL=http://192.168.1.42:4000 npx expo start
//
// Default (no env var): https://api.servd.pk, from app.json -> expo.extra.apiUrl.
// EXPO_PUBLIC_API_URL is accepted too, for parity with EAS env settings.

module.exports = ({ config }) => {
  const override = process.env.SERVD_API_URL || process.env.EXPO_PUBLIC_API_URL
  return {
    ...config,
    extra: {
      ...(config.extra || {}),
      ...(override ? { apiUrl: override.replace(/\/+$/, '') } : {}),
    },
  }
}
