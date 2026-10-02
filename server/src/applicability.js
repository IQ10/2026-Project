/**
 * Resolves one checklist item against the facility type and facility attributes.
 * A missing rule is Unconfigured. It is never treated as not applicable.
 */
export function resolveApplicability(rule, attributes) {
  if (!rule || rule.active_status === false || rule.active_status === 0) {
    return {
      status: 'Unconfigured',
      response: null,
      locked: false,
      review: true,
      reason: 'No active applicability rule for this checklist item and facility type.'
    };
  }

  const status = rule.applicability_status;
  if (status === 'Applicable') {
    return {
      status: 'Applicable',
      response: blankDefault(rule.default_response),
      locked: false,
      review: !!rule.review_required,
      reason: null
    };
  }

  if (status === 'Not Applicable') {
    return {
      status: 'Not Applicable',
      response: 'NA',
      locked: true,
      review: !!rule.review_required,
      reason: 'Not applicable for this facility type.'
    };
  }

  if (status === 'Conditional') {
    const attr = rule.conditional_attribute;
    if (!attr || !Object.prototype.hasOwnProperty.call(attributes, attr)) {
      return {
        status: 'Unconfigured',
        response: null,
        locked: false,
        review: true,
        reason: `Conditional rule requires facility attribute "${attr || '(missing)'}". It was not configured, so the item was left unanswered.`
      };
    }
    const present = attributes[attr] === true || attributes[attr] === 1;
    if (!present) {
      return {
        status: 'Not Applicable',
        response: 'NA',
        locked: true,
        review: !!rule.review_required,
        reason: `Facility attribute ${attr} is not present, so this item defaults to NA.`
      };
    }
    return {
      status: 'Applicable',
      response: blankDefault(rule.default_response),
      locked: false,
      review: !!rule.review_required,
      reason: rule.remarks || `Applicable because ${attr} is present at this facility.`
    };
  }

  return {
    status: 'Unconfigured',
    response: null,
    locked: false,
    review: true,
    reason: `Unsupported applicability status "${status}".`
  };
}

function blankDefault(value) {
  if (!value || value === 'Blank') return null;
  return value;
}

export function snapshotOf(rule, resolved, facilityType) {
  return {
    facilityType,
    ruleId: rule?.id || null,
    configuredStatus: rule?.applicability_status || null,
    conditionalAttribute: rule?.conditional_attribute || null,
    resolvedStatus: resolved.status,
    locked: resolved.locked,
    review: !!resolved.review,
    reason: resolved.reason || null
  };
}
