import { CommonLocals } from "server/common.middleware";
import forms from "server/core/forms";
import { allRules, rule, validateForm } from "server/core/forms-validation";
import { CustomRequest, CustomResponse } from "server/types";
import userServiceSingleton, { UserService } from "server/user/user.service";
import userTimezoneServiceSingleton, { UserTimeZoneService } from "../user-timezone.service";
import { loginPost } from "./login.controller";

export const TEMPLATE_REGISTER = "user/authentication/register";

export class RegisterController {

  public constructor(
    private userService: UserService = userServiceSingleton,
    private userTimezoneService: UserTimeZoneService = userTimezoneServiceSingleton) { }

  /**
   * Register form
   */
  public async registerForm(req: CustomRequest, res: CustomResponse<CommonLocals>) {
    res.locals.pageTitle = "Register";
    res.render(TEMPLATE_REGISTER, {
      ...req.body,
      timezones: await this.userTimezoneService.getAllTimeZonesAsOptions()
    });
  }

  /**
   * Register
   */
  public async register(req: CustomRequest, res: CustomResponse<CommonLocals>) {
    res.locals.pageTitle = "Register";

    const formAlerts = await validateForm(req.body, {
      "name": allRules(
        rule(forms.isSet, "Name is not set"),
        rule(forms.isUsername,
          "Your usename is too weird (either too short, "
          + "or has special chars other than '_' or '-', or starts with a number)")),
      "email": rule(forms.isSet, "Email is not set"),
      "password": rule(forms.isSet, "Password is not set"),
      "password-bis": rule((passwordBis) => passwordBis === req.body.password,
        "Passwords do not match"),
      "captcha": allRules(
        rule(forms.isSet, "Are you human???"),
        rule((captcha) => captcha.trim().toLowerCase()[0] === "y", "You didn't pass the human test!"))
    });

    if (!formAlerts) {
      const result = await this.userService.register(req.body.email, req.body.name, req.body.password);

      if (typeof result === "object") {
        if (req.body.timezone) {
          const user = result;
          user.set("timezone", forms.sanitizeString(req.body.timezone));
          await user.save();
        }
        loginPost(req, res);
        return;

      } else {
        res.locals.alerts.push({
          type: "danger",
          message: result
        });
      }

    } else {
      res.locals.alerts.push(...formAlerts);
    }

    this.registerForm(req, res);
  }

}

export default new RegisterController();
