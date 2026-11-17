'use strict';

/**
 * Hand-rolled lightweight input validation utility
 * Complies with Phase 2 requirements (zero external validator dependencies)
 */

function isString(val) {
  return typeof val === 'string';
}

function isValidEmail(email) {
  if (!isString(email)) return false;
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(email.trim());
}

function isInteger(val) {
  if (typeof val === 'number') {
    return Number.isInteger(val);
  }
  if (isString(val)) {
    return /^-?\d+$/.test(val.trim());
  }
  return false;
}

function isISO8601(dateStr) {
  if (!isString(dateStr)) return false;
  const d = new Date(dateStr);
  return !isNaN(d.getTime());
}

function validateJudgeInput(data) {
  const errors = [];
  const { first_name, last_name, email, phone, organization, designation, expertise, bio, kind, status } = data || {};

  if (!first_name || !isString(first_name) || first_name.trim().length === 0) {
    errors.push('first_name is required');
  }
  if (!last_name || !isString(last_name) || last_name.trim().length === 0) {
    errors.push('last_name is required');
  }
  if (!email || !isValidEmail(email)) {
    errors.push('valid email is required');
  }

  if (expertise !== undefined) {
    if (!Array.isArray(expertise)) {
      errors.push('expertise must be an array of strings');
    } else {
      if (expertise.length > 20) {
        errors.push('expertise array cannot exceed 20 items');
      }
      for (let i = 0; i < expertise.length; i++) {
        const item = expertise[i];
        if (!isString(item) || item.trim().length < 1 || item.trim().length > 40) {
          errors.push(`expertise item at index ${i} must be between 1 and 40 characters`);
        }
      }
    }
  }

  if (kind !== undefined && !['academic', 'industry', 'alumni', 'other'].includes(kind)) {
    errors.push('kind must be one of: academic, industry, alumni, other');
  }

  if (status !== undefined && !['active', 'inactive', 'archived'].includes(status)) {
    errors.push('status must be one of: active, inactive, archived');
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
}

function validateJudgePatch(data) {
  const errors = [];
  if (!data || typeof data !== 'object') {
    return { isValid: false, errors: ['Request body must be an object'] };
  }

  const allowedFields = ['first_name', 'last_name', 'email', 'phone', 'organization', 'designation', 'expertise', 'bio', 'kind', 'status'];
  const providedFields = Object.keys(data).filter((k) => allowedFields.includes(k) && data[k] !== undefined);

  if (providedFields.length === 0) {
    errors.push('At least one field must be provided for update');
  }

  if (data.first_name !== undefined && (!isString(data.first_name) || data.first_name.trim().length === 0)) {
    errors.push('first_name cannot be empty');
  }

  if (data.last_name !== undefined && (!isString(data.last_name) || data.last_name.trim().length === 0)) {
    errors.push('last_name cannot be empty');
  }

  if (data.email !== undefined && !isValidEmail(data.email)) {
    errors.push('valid email is required');
  }

  if (data.expertise !== undefined) {
    if (!Array.isArray(data.expertise)) {
      errors.push('expertise must be an array of strings');
    } else {
      if (data.expertise.length > 20) {
        errors.push('expertise array cannot exceed 20 items');
      }
      for (let i = 0; i < data.expertise.length; i++) {
        const item = data.expertise[i];
        if (!isString(item) || item.trim().length < 1 || item.trim().length > 40) {
          errors.push(`expertise item at index ${i} must be between 1 and 40 characters`);
        }
      }
    }
  }

  if (data.kind !== undefined && !['academic', 'industry', 'alumni', 'other'].includes(data.kind)) {
    errors.push('kind must be one of: academic, industry, alumni, other');
  }

  if (data.status !== undefined && !['active', 'inactive', 'archived'].includes(data.status)) {
    errors.push('status must be one of: active, inactive, archived');
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
}

function validateInvitationInput(data) {
  const errors = [];
  const { judge_id, competition_id, notes, expires_at } = data || {};

  if (!judge_id || !isInteger(judge_id)) {
    errors.push('valid judge_id is required');
  }
  if (!competition_id || !isInteger(competition_id)) {
    errors.push('valid competition_id is required');
  }
  if (expires_at !== undefined && !isISO8601(expires_at)) {
    errors.push('expires_at must be an ISO8601 date string');
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
}

function validateBulkInvitationInput(data) {
  const errors = [];
  const { judge_ids, competition_id, deadline_hours } = data || {};

  if (!Array.isArray(judge_ids) || judge_ids.length === 0) {
    errors.push('judge_ids must be a non-empty array of IDs');
  } else {
    if (judge_ids.length > 100) {
      errors.push('Cannot invite more than 100 judges in a single batch');
    }
    for (let i = 0; i < judge_ids.length; i++) {
      if (!isInteger(judge_ids[i])) {
        errors.push(`judge_id at index ${i} must be a valid integer ID`);
      }
    }
  }

  if (!competition_id || !isInteger(competition_id)) {
    errors.push('valid competition_id is required');
  }

  if (deadline_hours !== undefined) {
    const hours = Number(deadline_hours);
    if (!Number.isInteger(hours) || hours < 1 || hours > 720) {
      errors.push('deadline_hours must be an integer between 1 and 720 (30 days)');
    }
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
}

function validateResponseInput(data) {
  const errors = [];
  const { response, reason, note } = data || {};

  if (!response || !['accepted', 'declined', 'tentative'].includes(response)) {
    errors.push("response must be one of: 'accepted', 'declined', 'tentative'");
  }

  const comment = reason || note;
  if (comment !== undefined && isString(comment) && comment.length > 1000) {
    errors.push('reason / note cannot exceed 1000 characters');
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
}

function validateAvailabilityInput(data) {
  const errors = [];
  const slots = data?.slots || data?.windows;

  if (!Array.isArray(slots)) {
    return { isValid: false, errors: ['slots must be an array of time intervals'] };
  }

  if (slots.length > 10) {
    return { isValid: false, errors: ['Cannot submit more than 10 availability slots at once'] };
  }

  const parsedSlots = [];
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    if (!slot || typeof slot !== 'object') {
      errors.push(`Slot at index ${i} must be an object`);
      continue;
    }
    if (!isISO8601(slot.start_time)) {
      errors.push(`Slot at index ${i}: start_time must be a valid ISO8601 timestamp`);
      continue;
    }
    if (!isISO8601(slot.end_time)) {
      errors.push(`Slot at index ${i}: end_time must be a valid ISO8601 timestamp`);
      continue;
    }
    const start = new Date(slot.start_time).getTime();
    const end = new Date(slot.end_time).getTime();
    if (start >= end) {
      errors.push(`Slot at index ${i}: start_time must be strictly before end_time`);
      continue;
    }
    // Duration check: between 15 minutes and 7 days
    const durationMinutes = (end - start) / (1000 * 60);
    if (durationMinutes < 15) {
      errors.push(`Slot at index ${i}: duration must be at least 15 minutes`);
    }
    if (durationMinutes > 7 * 24 * 60) {
      errors.push(`Slot at index ${i}: duration cannot exceed 7 days`);
    }

    const isAvailable = slot.is_available !== false && slot.status !== 'unavailable';
    parsedSlots.push({ start, end, isAvailable, index: i });
  }

  // Check for conflicting overlapping slots within the submission
  for (let i = 0; i < parsedSlots.length; i++) {
    for (let j = i + 1; j < parsedSlots.length; j++) {
      const a = parsedSlots[i];
      const b = parsedSlots[j];
      const overlap = Math.max(a.start, b.start) < Math.min(a.end, b.end);
      if (overlap && a.isAvailable !== b.isAvailable) {
        errors.push(`Conflicting overlapping availability between slot ${a.index} and slot ${b.index}`);
      }
    }
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
}

function validateConflictsInput(data) {
  const errors = [];
  const conflicts = data?.conflicts;

  if (!Array.isArray(conflicts) || conflicts.length === 0) {
    return { isValid: false, errors: ['conflicts must be a non-empty array'] };
  }

  if (conflicts.length > 20) {
    return { isValid: false, errors: ['Cannot submit more than 20 conflicts at once'] };
  }

  for (let i = 0; i < conflicts.length; i++) {
    const c = conflicts[i];
    if (!c || typeof c !== 'object') {
      errors.push(`Conflict at index ${i} must be an object`);
      continue;
    }
    if (!c.description || !isString(c.description) || c.description.trim().length < 3) {
      errors.push(`Conflict at index ${i}: description is required (min 3 chars)`);
    } else if (c.description.length > 2000) {
      errors.push(`Conflict at index ${i}: description cannot exceed 2000 characters`);
    }

    if (c.severity !== undefined && !['low', 'medium', 'high'].includes(c.severity)) {
      errors.push(`Conflict at index ${i}: severity must be one of: low, medium, high`);
    }

    if (c.subject_kind !== undefined && (!isString(c.subject_kind) || c.subject_kind.length > 100)) {
      errors.push(`Conflict at index ${i}: subject_kind cannot exceed 100 characters`);
    }

    if (c.subject_name !== undefined && (!isString(c.subject_name) || c.subject_name.length > 200)) {
      errors.push(`Conflict at index ${i}: subject_name cannot exceed 200 characters`);
    }
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
}

function validateAssignmentInput(data) {
  const errors = [];
  const { session_id, judge_id, role } = data || {};

  if (!session_id || !isInteger(session_id)) {
    errors.push('valid session_id is required');
  }
  if (!judge_id || !isInteger(judge_id)) {
    errors.push('valid judge_id is required');
  }
  if (role !== undefined && !['head_judge', 'judge', 'evaluator'].includes(role)) {
    errors.push('role must be one of: head_judge, judge, evaluator');
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
}

function validateAssignmentPatch(data) {
  const errors = [];
  if (!data || typeof data !== 'object') {
    return { isValid: false, errors: ['Request body must be an object'] };
  }

  if (data.judge_id !== undefined || data.session_id !== undefined) {
    errors.push('Cannot change judge_id or session_id via PATCH. Delete and recreate assignment to preserve EXCLUDE semantics.');
  }

  if (data.role === undefined) {
    errors.push('role is required for update');
  } else if (!['head_judge', 'judge', 'evaluator'].includes(data.role)) {
    errors.push('role must be one of: head_judge, judge, evaluator');
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
}

function validateAssignmentResponse(data) {
  const errors = [];
  const { response, reason, note } = data || {};

  if (!response || !['accepted', 'declined', 'confirmed'].includes(response)) {
    errors.push("response must be one of: 'accepted', 'declined'");
  }

  const comment = reason || note;
  if (comment !== undefined && isString(comment) && comment.length > 1000) {
    errors.push('reason cannot exceed 1000 characters');
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
}

function validateAttendanceInput(data) {
  const errors = [];
  const { assignment_id } = data || {};

  if (!assignment_id || !isInteger(assignment_id)) {
    errors.push('valid assignment_id is required');
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
}

function validateAttendancePatch(data) {
  const errors = [];
  const { status, note, notes } = data || {};

  const allowedStatuses = ['checked_in', 'late', 'absent', 'early_departure', 'not_arrived', 'present', 'excused'];
  if (!status || !allowedStatuses.includes(status)) {
    errors.push(`status must be one of: ${allowedStatuses.join(', ')}`);
  }

  const comment = note || notes;
  if (comment !== undefined && isString(comment) && comment.length > 1000) {
    errors.push('note cannot exceed 1000 characters');
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
}

function validateReplacementInput(data) {
  const errors = [];
  const { replacement_judge_id, reason } = data || {};

  if (replacement_judge_id !== undefined && !isInteger(replacement_judge_id)) {
    errors.push('replacement_judge_id must be a valid integer ID');
  }

  if (reason !== undefined && isString(reason) && reason.length > 1000) {
    errors.push('reason cannot exceed 1000 characters');
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
}

module.exports = {
  isString,
  isValidEmail,
  isInteger,
  isISO8601,
  validateJudgeInput,
  validateJudgePatch,
  validateInvitationInput,
  validateBulkInvitationInput,
  validateResponseInput,
  validateAvailabilityInput,
  validateConflictsInput,
  validateAssignmentInput,
  validateAssignmentPatch,
  validateAssignmentResponse,
  validateAttendanceInput,
  validateAttendancePatch,
  validateReplacementInput,
};
