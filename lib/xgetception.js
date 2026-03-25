class XgetException extends Error {}

class XgetNetException extends XgetException {
  constructor(statusCode, statusMessage) {
    super(`ERROR ${statusCode}: ${statusMessage}`);
    this.statusCode = statusCode;
    this.statusMessage = statusMessage;
  }
}

function XGET_CHECK_VAR(val, varName, type, optional) {
  if (![undefined, null].includes(val) || !optional) {
    let isFunc = typeof type === 'function';
    if (!(isFunc ? val instanceof type : typeof val === type)) {
      const er = new XgetException(
        `<${varName}>${optional ? ', if defined,' : ''} must be a valid type \`${isFunc ? type.name : type}\``,
      );
      throw er;
    } else return true;
  }
}

export {XgetException, XgetNetException, XGET_CHECK_VAR};
