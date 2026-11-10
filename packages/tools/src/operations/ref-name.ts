export const REF_NAME_PATTERN = '^(?!-)(?!@$)(?!HEAD$)(?!\\.)(?!/)(?!.*(?:\\.\\.|@\\{|//|/\\.|\\.lock(?:/|$)|\\.$|/$))[^\\x00-\\x20\\x7f~^:?*\\[\\\\]+$';

export const REF_NAME_MAX_LENGTH = 255;

export const withRefNameRule = (input: Record<string, unknown>): Record<string, unknown> => {
  const properties = input['properties'];
  if (typeof properties !== 'object' || properties === null) return input;
  const ruled = Object.fromEntries(
    Object.entries(properties).map(([name, schema]) => {
      if (typeof schema !== 'object' || schema === null || Reflect.get(schema, 'refName') !== true) return [name, schema];
      const { refName: _refName, ...rest } = schema as Record<string, unknown>;
      return [name, { ...rest, type: 'string', pattern: REF_NAME_PATTERN, maxLength: REF_NAME_MAX_LENGTH }];
    }),
  );
  return { ...input, properties: ruled };
};
