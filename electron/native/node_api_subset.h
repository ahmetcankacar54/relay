// The few Node-API functions Relay's addons (widget-center.swift,
// window-space.swift) call, declared as in node_api.h. They resolve at load
// time from the Electron main process (linked with -undefined dynamic_lookup);
// Node-API's ABI is stable.
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef struct napi_env__ *napi_env;
typedef struct napi_value__ *napi_value;
typedef struct napi_callback_info__ *napi_callback_info;
typedef enum { napi_ok = 0 } napi_status;
typedef napi_value (*napi_callback)(napi_env env, napi_callback_info info);

#define NAPI_AUTO_LENGTH SIZE_MAX

napi_status napi_create_function(napi_env env, const char *utf8name,
                                 size_t length, napi_callback cb, void *data,
                                 napi_value *result);
napi_status napi_set_named_property(napi_env env, napi_value object,
                                    const char *utf8name, napi_value value);
napi_status napi_get_cb_info(napi_env env, napi_callback_info cbinfo,
                             size_t *argc, napi_value *argv,
                             napi_value *this_arg, void **data);
napi_status napi_get_value_string_utf8(napi_env env, napi_value value,
                                       char *buf, size_t bufsize,
                                       size_t *result);
napi_status napi_get_buffer_info(napi_env env, napi_value value, void **data,
                                 size_t *length);
napi_status napi_get_boolean(napi_env env, bool value, napi_value *result);
