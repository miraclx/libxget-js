/* eslint-disable max-classes-per-file */

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
    // eslint-disable-next-line valid-typeof
    if (typeof val !== type) {
      const er = new XgetException(`<${varName}>${optional ? ', if defined,' : ''} must be a valid type \`${type}\``);
      throw er;
    } else return true;
  }
}

module.exports = {XgetException, XgetNetException, XGET_CHECK_VAR};
