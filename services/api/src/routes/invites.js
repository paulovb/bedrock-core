const Router = require('@koa/router');
const Joi = require('@hapi/joi');
const validate = require('../utils/middleware/validate');
const { authenticate, fetchUser } = require('../utils/middleware/authenticate');
const { requirePermissions } = require('../utils/middleware/permissions');

const { NotFoundError, BadRequestError, GoneError } = require('../utils/errors');
const { Invite, User } = require('../models');

const { sendInvite } = require('../utils/emails');
const { createUserTemporaryToken } = require('../utils/tokens');

const router = new Router();

function getToken(invite) {
  return createUserTemporaryToken({ inviteId: invite._id, email: invite.email }, 'invite');
}

router
  .param('inviteId', async (id, ctx, next) => {
    const invite = await Invite.findById(id);
    ctx.state.invite = invite;

    if (!invite) {
      throw new NotFoundError();
    } else if (invite.deletedAt) {
      throw new GoneError();
    }

    return next();
  })
  .use(authenticate({ type: 'user' }))
  .use(fetchUser)
  .use(requirePermissions({ endpoint: 'users', permission: 'read', scope: 'global' }))
  .post(
    '/search',
    validate({
      body: Joi.object({
        skip: Joi.number().default(0),
        sort: Joi.object({
          field: Joi.string().required(),
          order: Joi.string().required(),
        }).default({
          field: 'createdAt',
          order: 'asc',
        }),
        limit: Joi.number().positive().default(50),
      }),
    }),
    async (ctx) => {
      const { sort, skip, limit } = ctx.request.body;
      const query = { deletedAt: { $exists: false } };
      const invites = await Invite.find(query)
        .sort({ [sort.field]: sort.order === 'desc' ? -1 : 1 })
        .skip(skip)
        .limit(limit);

      const total = await Invite.countDocuments(query);

      ctx.body = {
        data: invites,
        meta: {
          total,
          skip,
          limit,
        },
      };
    }
  )
  .use(requirePermissions({ endpoint: 'users', permission: 'write', scope: 'global' }))
  .post(
    '/',
    validate({
      body: Joi.object({
        emails: Joi.array().items(Joi.string().email()).required(),
      }),
    }),
    async (ctx) => {
      const { authUser } = ctx.state;
      const { emails } = ctx.request.body;

      for (let email of [...new Set(emails)]) {
        if ((await User.countDocuments({ email })) > 0) {
          throw new BadRequestError(`${email} is already a user.`);
        }
        const invite = await Invite.findOneAndUpdate(
          {
            email,
            status: 'invited',
          },
          { status: 'invited', email, $unset: { deletedAt: 1 } },
          {
            new: true,
            upsert: true,
          }
        );
        await sendInvite({ email, sender: authUser, token: getToken(invite) });
      }
      ctx.status = 204;
    }
  )
  .post('/:inviteId/resend', async (ctx) => {
    const { invite, authUser } = ctx.state;
    await sendInvite({ email: invite.email, sender: authUser, token: getToken(invite) });
    ctx.status = 204;
  })
  .delete('/:inviteId', async (ctx) => {
    const { invite } = ctx.state;
    await invite.delete();
    ctx.status = 204;
  });

module.exports = router;
